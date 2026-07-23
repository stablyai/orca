import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeFileReadTooLargeError } from '../../shared/node-bounded-file-reader'
import {
  readWslHookRelayBundle,
  readWslHookRelayBundleVersion,
  WSL_HOOK_RELAY_MAX_BUNDLE_BYTES,
  WSL_HOOK_RELAY_MAX_VERSION_FILE_BYTES
} from './wsl-hook-relay-launch'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempFile(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-wsl-relay-bounds-'))
  roots.push(root)
  return join(root, name)
}

function createSparseFile(path: string, bytes: number): void {
  const descriptor = openSync(path, 'w')
  try {
    ftruncateSync(descriptor, bytes)
  } finally {
    closeSync(descriptor)
  }
}

describe('WSL hook relay local file bounds', () => {
  it('preserves ordinary version and bundle reads', () => {
    const versionPath = tempFile('.version')
    const bundlePath = tempFile('relay.js')
    writeFileSync(versionPath, '1.2.3\n')
    writeFileSync(bundlePath, 'console.log("relay")')

    expect(readWslHookRelayBundleVersion(versionPath)).toBe('1.2.3')
    expect(readWslHookRelayBundle(bundlePath).toString('utf8')).toBe('console.log("relay")')
  })

  it('rejects an oversized version marker before materializing it', () => {
    const versionPath = tempFile('.version')
    createSparseFile(versionPath, WSL_HOOK_RELAY_MAX_VERSION_FILE_BYTES + 1)

    expect(() => readWslHookRelayBundleVersion(versionPath)).toThrow(NodeFileReadTooLargeError)
  })

  it('rejects an oversized bundle before materializing or base64-expanding it', () => {
    const bundlePath = tempFile('relay.js')
    createSparseFile(bundlePath, WSL_HOOK_RELAY_MAX_BUNDLE_BYTES + 1)

    expect(() => readWslHookRelayBundle(bundlePath)).toThrow(NodeFileReadTooLargeError)
  })
})
