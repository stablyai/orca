import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  sshRelayArtifactCacheRoot,
  SSH_RELAY_ARTIFACT_CACHE_ROOT_NAMESPACE
} from './ssh-relay-artifact-cache-root'

const originalEnvironmentRoot = process.env.ORCA_SSH_RELAY_ARTIFACT_CACHE_ROOT

afterEach(() => {
  if (originalEnvironmentRoot === undefined) {
    delete process.env.ORCA_SSH_RELAY_ARTIFACT_CACHE_ROOT
  } else {
    process.env.ORCA_SSH_RELAY_ARTIFACT_CACHE_ROOT = originalEnvironmentRoot
  }
})

describe('SSH relay artifact cache root', () => {
  it('derives one fixed schema-versioned namespace below native user data', () => {
    const userDataPath = join(tmpdir(), 'Orca User Data')

    expect(sshRelayArtifactCacheRoot(userDataPath)).toBe(
      join(userDataPath, 'ssh-relay-runtime-cache', 'v1')
    )
    expect(SSH_RELAY_ARTIFACT_CACHE_ROOT_NAMESPACE).toEqual({
      directoryName: 'ssh-relay-runtime-cache',
      schemaVersion: 'v1'
    })
    expect(Object.isFrozen(SSH_RELAY_ARTIFACT_CACHE_ROOT_NAMESPACE)).toBe(true)
  })

  it('rejects empty and relative user-data paths', () => {
    for (const value of ['', '.', 'relative/user-data']) {
      expect(() => sshRelayArtifactCacheRoot(value)).toThrow(/absolute|user.data/i)
    }
  })

  it('cannot be redirected through a runtime environment variable', () => {
    const userDataPath = join(tmpdir(), 'Orca User Data')
    process.env.ORCA_SSH_RELAY_ARTIFACT_CACHE_ROOT = join(tmpdir(), 'hostile-cache-root')

    expect(sshRelayArtifactCacheRoot(userDataPath)).toBe(
      join(userDataPath, 'ssh-relay-runtime-cache', 'v1')
    )
  })
})
