// Exercise named-pipe ownership branches on any host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  publishDaemonEndpoint,
  readDaemonEndpointOwnershipState,
  readDaemonSocketIdentity
} from './daemon-endpoint-ownership'

describe('daemon endpoint ownership on win32', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-endpoint-win32-'))
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('publishes without probing or touching the filesystem', async () => {
    const boundPath = join(dir, 'bound.sock')
    const canonicalPath = join(dir, 'daemon.sock')
    writeFileSync(boundPath, '')
    const probe = vi.fn()

    const outcome = await publishDaemonEndpoint(boundPath, canonicalPath, probe)

    expect(outcome).toEqual({ status: 'published', identity: null })
    expect(probe).not.toHaveBeenCalled()
    expect(existsSync(canonicalPath)).toBe(false)
  })

  it('publishes even where the canonical name is already taken', async () => {
    const boundPath = join(dir, 'bound.sock')
    const canonicalPath = join(dir, 'daemon.sock')
    writeFileSync(boundPath, '')
    writeFileSync(canonicalPath, 'someone else')
    const probe = vi.fn()

    // Windows binds the canonical pipe directly; successful listen already establishes ownership.
    await expect(publishDaemonEndpoint(boundPath, canonicalPath, probe)).resolves.toEqual({
      status: 'published',
      identity: null
    })
    expect(probe).not.toHaveBeenCalled()
  })

  it('reports no identity, so nothing can later claim ownership was lost', () => {
    const realFile = join(dir, 'daemon.sock')
    writeFileSync(realFile, '')

    expect(readDaemonSocketIdentity(realFile)).toBeNull()
  })

  it('never reports lost ownership, so a daemon is never retired on Windows', () => {
    const missing = join(dir, 'gone.sock')

    // Named pipes have no directory entry; absence cannot establish a takeover.
    expect(readDaemonEndpointOwnershipState(missing, null)).toBe('indeterminate')
    expect(readDaemonEndpointOwnershipState(missing, { dev: 1n, ino: 2n })).toBe('indeterminate')
  })
})
