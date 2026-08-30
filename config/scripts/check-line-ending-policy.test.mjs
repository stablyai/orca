import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import {
  checkLineEndingPolicy,
  containsCrlf,
  CRLF_PINNED_PATHS,
  findPinViolations,
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

describe('findPinViolations', () => {
  const shim = 'resources/win32/bin/orca.cmd'
  const pin = (over = {}) => [{ path: shim, tracked: true, crlf: false, ...over }]
  const attrs = (eol) => new Map([[shim, eol === undefined ? {} : { eol }]])

  it('passes the shim when it is LF in the index and CRLF on checkout', () => {
    expect(findPinViolations(pin(), attrs('crlf'))).toEqual([])
  })

  // This is what #17303's blanket rule alone produces, and what flips a shipped byte.
  it('flags the shim once the blanket LF rule reclaims it', () => {
    const found = findPinViolations(pin(), attrs('lf'))
    expect(found).toHaveLength(1)
    expect(found[0].rule).toContain('not crlf')
  })

  it('flags an unpinned shim, which is the accident that decided its bytes before', () => {
    const found = findPinViolations(pin(), attrs(undefined))
    expect(found).toHaveLength(1)
    expect(found[0].rule).toContain('unspecified')
  })

  // eol=crlf converts on checkout, so a CRLF blob would reach macOS and Linux too.
  it('still requires the stored blob to be LF', () => {
    const found = findPinViolations(pin({ crlf: true }), attrs('crlf'))
    expect(found).toHaveLength(1)
    expect(found[0].rule).toContain('blob contains CRLF')
  })

  // Otherwise deleting the file would silently empty the rule instead of failing it.
  it('flags a pin whose path is no longer tracked instead of skipping it', () => {
    const found = findPinViolations(pin({ tracked: false }), attrs('crlf'))
    expect(found).toHaveLength(1)
    expect(found[0].rule).toContain('not tracked')
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

  it('keeps the Windows CLI shim pinned to CRLF, outside the LF population', () => {
    const { entries, pins } = checkLineEndingPolicy(root)
    // The literal path, not CRLF_PINNED_PATHS: comparing the result to the constant
    // that produced it passes just as happily when someone empties the constant.
    expect(CRLF_PINNED_PATHS).toContain('resources/win32/bin/orca.cmd')
    expect(pins.map((p) => p.path)).toContain('resources/win32/bin/orca.cmd')
    expect(pins.every((p) => p.tracked && !p.crlf)).toBe(true)
    // The two rules must not overlap: the shim has no shebang and no executable bit,
    // so requiring CRLF here cannot contradict the LF rule above.
    expect(entries.map((e) => e.path)).not.toContain('resources/win32/bin/orca.cmd')
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
