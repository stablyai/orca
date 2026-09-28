import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  readWindowsWatcherArtifact,
  WINDOWS_WATCHER_VERSION,
  WINDOWS_WATCHER_PATCH
} from './windows-watcher-artifact.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(overrides = {}, machine = 0x8664) {
  const root = mkdtempSync(join(tmpdir(), 'orca-watcher-receipt-'))
  roots.push(root)
  const directory = join(root, 'x64')
  mkdirSync(directory)
  const bytes = Buffer.alloc(70)
  bytes.write('MZ')
  bytes.writeUInt32LE(64, 60)
  bytes.write('PE\0\0', 64, 'latin1')
  bytes.writeUInt16LE(machine, 68)
  writeFileSync(join(directory, 'watcher.node'), bytes)
  writeFileSync(join(directory, 'LICENSE'), 'Permission is hereby granted')
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({
      version: WINDOWS_WATCHER_VERSION,
      arch: 'x64',
      sanitized: false,
      patchSha256: createHash('sha256').update(readFileSync(WINDOWS_WATCHER_PATCH)).digest('hex'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...overrides
    })
  )
  return root
}

it('accepts a matching shipping build receipt and preserves its license', () => {
  const root = fixture()
  expect(readWindowsWatcherArtifact('x64', root)).toEqual({
    binary: join(root, 'x64/watcher.node'),
    license: join(root, 'x64/LICENSE')
  })
})

it.each([
  { version: '2.5.5' },
  { arch: 'arm64' },
  { sanitized: true },
  { sanitized: undefined },
  { patchSha256: 'old patch' }
])('rejects stale and diagnostic artifacts: %j', (overrides) => {
  expect(() => readWindowsWatcherArtifact('x64', fixture(overrides))).toThrow('shipping source')
})

it('rejects corrupted and wrong-architecture binaries even with a plausible receipt', () => {
  expect(() => readWindowsWatcherArtifact('x64', fixture({ sha256: 'wrong' }))).toThrow('binary')
  expect(() => readWindowsWatcherArtifact('x64', fixture({}, 0xaa64))).toThrow('architecture')
  expect(() => readWindowsWatcherArtifact('../x64')).toThrow('Unsupported')
})
