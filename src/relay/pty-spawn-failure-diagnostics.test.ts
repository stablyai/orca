import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as fs from 'node:fs'
import type { Stats } from 'node:fs'

const PACKAGE_ROOT = '/relay/node_modules/node-pty'
const RELEASE_HELPER = `${PACKAGE_ROOT}/build/Release/spawn-helper`

const { statSyncMock } = vi.hoisted(() => ({ statSyncMock: vi.fn() }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, statSync: statSyncMock }
})

import {
  formatRelayPtySpawnError,
  isOpaqueNodePtySpawnFailure
} from './pty-spawn-failure-diagnostics'

function stubHelperModes(modes: Record<string, number>): void {
  statSyncMock.mockImplementation((path: string) => {
    const mode = modes[path]
    if (mode === undefined) {
      throw Object.assign(new Error(`ENOENT: stat '${path}'`), { code: 'ENOENT' })
    }
    return { mode } as Stats
  })
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  statSyncMock.mockReset()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

describe('isOpaqueNodePtySpawnFailure', () => {
  it('matches the unpatched node-pty catch-all', () => {
    expect(isOpaqueNodePtySpawnFailure('posix_spawnp failed.')).toBe(true)
    expect(isOpaqueNodePtySpawnFailure('posix_spawnp failed')).toBe(true)
  })

  it('leaves a message that already names its step alone', () => {
    expect(
      isOpaqueNodePtySpawnFailure(
        'node-pty: posix_spawn failed: EACCES (errno 13, Permission denied)'
      )
    ).toBe(false)
  })
})

describe('formatRelayPtySpawnError', () => {
  it('names the shell, cwd and host the client cannot see', () => {
    stubHelperModes({ [RELEASE_HELPER]: 0o100755 })

    const message = formatRelayPtySpawnError(
      new Error('posix_spawnp failed.'),
      '/bin/zsh',
      '/home/dev/repo',
      PACKAGE_ROOT
    ).message

    expect(message).toContain('/bin/zsh')
    expect(message).toContain('/home/dev/repo')
    expect(message).toContain(`node ${process.versions.node}`)
  })

  it('reports the spawn-helper mode when node-pty gives no step', () => {
    stubHelperModes({ [RELEASE_HELPER]: 0o100644 })

    const message = formatRelayPtySpawnError(
      new Error('posix_spawnp failed.'),
      '/bin/zsh',
      '/home/dev/repo',
      PACKAGE_ROOT
    ).message

    // The regression this exists for: a bare "posix_spawnp failed." told nobody that the helper
    // node-pty was about to exec had lost its +x bit.
    expect(message).toContain('NOT executable')
    expect(message).toContain(RELEASE_HELPER)
  })

  it('reports an absent helper', () => {
    stubHelperModes({})

    const message = formatRelayPtySpawnError(
      new Error('posix_spawnp failed.'),
      '/bin/zsh',
      '/repo',
      PACKAGE_ROOT
    ).message

    expect(message).toContain('absent')
  })

  it('does not probe the helper for a failure that already names its step', () => {
    stubHelperModes({ [RELEASE_HELPER]: 0o100644 })

    const message = formatRelayPtySpawnError(
      new Error('node-pty: posix_openpt failed: EMFILE (errno 24, Too many open files)'),
      '/bin/zsh',
      '/repo',
      PACKAGE_ROOT
    ).message

    expect(message).toContain('posix_openpt failed: EMFILE')
    expect(message).not.toContain('spawn-helper')
  })

  it('never emits the daemon-restart markers the client keys on', () => {
    stubHelperModes({ [RELEASE_HELPER]: 0o100644 })

    const message = formatRelayPtySpawnError(
      new Error('posix_spawnp failed.'),
      '/bin/zsh',
      '/repo',
      PACKAGE_ROOT
    ).message

    // shouldOfferDaemonRestart() would otherwise offer to restart a *local* daemon for a remote
    // host's failure.
    expect(message).not.toContain("Daemon's node-pty install is gone")
    expect(message).not.toContain('node-pty: posix_spawn failed: ENOENT')
  })

  it('keeps the original stack', () => {
    stubHelperModes({ [RELEASE_HELPER]: 0o100755 })
    const original = new Error('posix_spawnp failed.')

    expect(formatRelayPtySpawnError(original, '/bin/sh', '/repo', PACKAGE_ROOT).stack).toBe(
      original.stack
    )
  })
})
