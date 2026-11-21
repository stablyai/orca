import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { writeFileAtomically } from '../../../filesystem/atomic-file-publication'
import { ConcurrentFileEditError } from '../../../filesystem/concurrent-file-edit-guard'
import { readObservedFileSync } from '../../../filesystem/file-content-observation'
import { withHookPassEditGuard } from './codex-hook-pass-edit-guard'

let root: string
let config: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-edit-guard-'))
  config = join(root, 'config.toml')
  writeFileSync(config, 'model = "seed"\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('never publishes over a write another writer made after the pass started', () => {
  const result = withHookPassEditGuard([config], () => {
    writeFileSync(config, 'model = "theirs"\n')
    expect(() => writeFileAtomically(config, 'model = "ours"\n')).toThrow(ConcurrentFileEditError)
  })

  expect(result.conflict).toBe(config)
  expect(readFileSync(config, 'utf-8')).toBe('model = "theirs"\n')
})

it('lets a pass read back and replace what it published itself', () => {
  const result = withHookPassEditGuard([config], () => {
    writeFileAtomically(config, 'model = "first"\n')
    expect(readObservedFileSync(config, 'utf-8')).toBe('model = "first"\n')
    writeFileAtomically(config, 'model = "second"\n')
  })

  expect(result.conflict).toBeNull()
  expect(readFileSync(config, 'utf-8')).toBe('model = "second"\n')
})

// Symlink creation needs extra privileges on Windows.
it.skipIf(process.platform === 'win32')(
  'treats a symlink and its target as one file across the pass',
  () => {
    const link = join(root, 'linked.toml')
    symlinkSync(config, link)
    const result = withHookPassEditGuard([link, config], () => {
      writeFileAtomically(config, 'model = "ours"\n')
      expect(readObservedFileSync(link, 'utf-8')).toBe('model = "ours"\n')
    })

    expect(result.conflict).toBeNull()
  }
)
