import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { writeFileAtomically } from './atomic-file-publication'
import { ConcurrentFileEditError, withConcurrentFileEditGuard } from './concurrent-file-edit-guard'
import { readObservedFileSync } from './file-content-observation'

let root: string
let config: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-edit-guard-'))
  config = join(root, 'config.toml')
  writeFileSync(config, 'model = "seed"\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('never publishes over a write another writer made after the pass started', () => {
  const result = withConcurrentFileEditGuard([config], () => {
    writeFileSync(config, 'model = "theirs"\n')
    expect(() => writeFileAtomically(config, 'model = "ours"\n')).toThrow(ConcurrentFileEditError)
  })

  expect(result.conflict).toBe(config)
  expect(readFileSync(config, 'utf-8')).toBe('model = "theirs"\n')
})

it('lets a pass read back and replace what it published itself', () => {
  const result = withConcurrentFileEditGuard([config], () => {
    writeFileAtomically(config, 'model = "first"\n')
    expect(readObservedFileSync(config, 'utf-8')).toBe('model = "first"\n')
    writeFileAtomically(config, 'model = "second"\n')
  })

  expect(result.conflict).toBeNull()
  expect(readFileSync(config, 'utf-8')).toBe('model = "second"\n')
})
