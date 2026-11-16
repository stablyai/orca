import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findSlotProblems, mergeManifest, sha256Of } from './orcad-prebuild-slot-contents.mjs'
const dirs = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'orcad-slot-contents-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const entry = (files = {}) => ({
  platform: 'darwin',
  arch: 'arm64',
  libc: 'none',
  glibc: null,
  napi: 8,
  files
})
const next = (slot, overrides = {}) => ({
  slot,
  version: '1.1.0',
  napi: 8,
  nodeHeaders: '24.21.0',
  entry: entry(),
  ...overrides
})

describe('findSlotProblems', () => {
  it('passes only when every named slot is present and every file matches its hash', () => {
    const dir = temp()
    mkdirSync(join(dir, 'darwin-arm64'))
    writeFileSync(join(dir, 'darwin-arm64', 'pty.node'), 'binary')
    const manifest = mergeManifest(
      null,
      next('darwin-arm64', {
        entry: entry({ 'pty.node': sha256Of(join(dir, 'darwin-arm64', 'pty.node')) })
      })
    )
    expect(findSlotProblems(manifest, dir, ['darwin-arm64'])).toEqual([])
    expect(findSlotProblems(manifest, dir, ['darwin-arm64', 'win32-x64'])).toEqual([
      'win32-x64: not built'
    ])
    writeFileSync(join(dir, 'darwin-arm64', 'pty.node'), 'torn')
    expect(findSlotProblems(manifest, dir, ['darwin-arm64'])).toEqual([
      'darwin-arm64/pty.node: sha256 does not match the manifest'
    ])
    expect(findSlotProblems(null, dir, ['darwin-arm64'])).toEqual([
      'manifest.json is missing or not schema 2'
    ])
  })
})
