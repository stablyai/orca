import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCountRatchet, runEntryRatchet } from './ratchet-baseline.mjs'

describe('runEntryRatchet', () => {
  let root
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  function ratchet(current) {
    root = mkdtempSync(join(tmpdir(), 'orca-ratchet-'))
    writeFileSync(join(root, 'baseline.txt'), '# header\na.ts\nb.ts\n')
    return {
      name: 'demo',
      baselinePath: 'baseline.txt',
      header: ['# header'],
      collect: () => current,
      fix: ['Fix the file.']
    }
  }

  it('prunes stale entries only and still fails on a new one', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(runEntryRatchet(ratchet(['a.ts', 'c.ts']), root, '--prune')).toBe(1)
    expect(readFileSync(join(root, 'baseline.txt'), 'utf8')).toBe('# header\na.ts\n')
  })
})

describe('runCountRatchet', () => {
  let root
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  function ratchet(current) {
    root = mkdtempSync(join(tmpdir(), 'orca-count-ratchet-'))
    writeFileSync(join(root, 'baseline.txt'), '# header\n2 a.ts # why\n1 b.ts\n')
    return {
      name: 'demo',
      baselinePath: 'baseline.txt',
      header: ['# header'],
      collect: () => new Map(current),
      unit: 'thing(s)',
      fix: ['Fix the file.']
    }
  }

  it('prunes rows down only, keeping their notes', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(
      runCountRatchet(
        ratchet([
          ['a.ts', 1],
          ['c.ts', 4]
        ]),
        root,
        '--prune'
      )
    ).toBe(0)
    expect(readFileSync(join(root, 'baseline.txt'), 'utf8')).toBe('# header\n1 a.ts # why\n')
  })
})
