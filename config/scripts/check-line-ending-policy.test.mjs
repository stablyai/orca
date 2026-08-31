import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import {
  checkLineEndingPolicy,
  containsCrlf,
  findViolations,
  hasShebang,
  parseCheckAttr
} from './check-line-ending-policy.mjs'

const lf = (attrs = { eol: 'lf' }) => new Map([['a.sh', attrs]])

describe('hasShebang', () => {
  it('accepts a leading #!', () => {
    expect(hasShebang(Buffer.from('#!/usr/bin/env bash\n'))).toBe(true)
  })

  it('rejects a #! that is not at byte zero', () => {
    expect(hasShebang(Buffer.from('\n#!/bin/sh\n'))).toBe(false)
    expect(hasShebang(Buffer.from('# heading\n#!not-a-shebang\n'))).toBe(false)
  })

  it('rejects a one-byte blob', () => {
    expect(hasShebang(Buffer.from('#'))).toBe(false)
  })
})

describe('containsCrlf', () => {
  it('finds CRLF anywhere, not just on the shebang line', () => {
    expect(containsCrlf(Buffer.from('#!/bin/sh\nexit 0\r\n'))).toBe(true)
  })

  it('does not treat a lone CR as CRLF', () => {
    expect(containsCrlf(Buffer.from('#!/bin/sh\rexit 0\n'))).toBe(false)
  })
})

describe('parseCheckAttr', () => {
  it('groups NUL-separated triples by path', () => {
    expect(parseCheckAttr('a.sh\0eol\0lf\0b.sh\0eol\0crlf\0')).toEqual(
      new Map([
        ['a.sh', { eol: 'lf' }],
        ['b.sh', { eol: 'crlf' }]
      ])
    )
  })

  it('ignores a trailing partial record rather than inventing a path', () => {
    expect(parseCheckAttr('a.sh\0eol\0lf\0b.sh\0eol\0')).toEqual(new Map([['a.sh', { eol: 'lf' }]]))
  })
})

describe('findViolations', () => {
  const entry = (over = {}) => [
    { path: 'a.sh', reason: 'starts with a shebang', crlf: false, ...over }
  ]

  it('passes a file that is LF in the index and pinned to LF on checkout', () => {
    expect(findViolations(entry(), lf())).toEqual([])
  })

  it('flags a committed CRLF blob even when the checkout attribute is right', () => {
    const found = findViolations(entry({ crlf: true }), lf())
    expect(found).toHaveLength(1)
    expect(found[0].rule).toContain('blob contains CRLF')
  })

  it('flags an eol=crlf pin even when the committed blob is clean', () => {
    const found = findViolations(entry(), lf({ eol: 'crlf' }))
    expect(found).toHaveLength(1)
    expect(found[0].rule).toContain('eol=crlf')
  })

  // The regression this whole gate exists for: main had no blanket pin, so every
  // shebang file resolved to `unspecified` and a core.autocrlf=true clone broke it.
  it('flags an unpinned file, which is the state that shipped a broken launcher', () => {
    const found = findViolations(entry(), lf({}))
    expect(found).toHaveLength(1)
    expect(found[0].rule).toContain('unspecified')
  })

  it('reports both failures when a file manages each independently', () => {
    expect(findViolations(entry({ crlf: true }), lf({ eol: 'crlf' }))).toHaveLength(2)
  })
})

describe('the repo itself', () => {
  const root = new URL('../..', import.meta.url).pathname

  it('pins every tracked executable artifact to LF', () => {
    const { entries, violations } = checkLineEndingPolicy(root)
    expect(violations).toEqual([])
    // Guards against the scan silently discovering nothing and reading as clean.
    expect(entries.length).toBeGreaterThan(100)
  })

  // A silent git failure would empty the population and read as a clean repo.
  it('throws rather than reporting clean when git cannot answer', () => {
    expect(() => checkLineEndingPolicy(tmpdir())).toThrow(/git ls-files exited/)
  })

  it('covers the shipped launchers, the packaging scripts and the commit hook', () => {
    const covered = new Set(checkLineEndingPolicy(root).entries.map((e) => e.path))
    for (const shipped of [
      'resources/linux/bin/orca-ide',
      'resources/darwin/bin/orca',
      'resources/linux/packaging/after-install.sh',
      'resources/linux/packaging/after-remove.sh',
      '.husky/pre-commit'
    ]) {
      expect(covered).toContain(shipped)
    }
  })
})
