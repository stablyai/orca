import { rename, rm } from 'node:fs/promises'

import { sshRelayArtifactCacheErrorCode } from './ssh-relay-artifact-cache-lock-record'

const RETRY_INTERVAL_MS = 50
const RETRY_TIMEOUT_MS = 5_000
const TOKEN = /^[0-9a-f]{32}$/
const WINDOWS_SHARING_ERRORS = new Set(['EACCES', 'EPERM'])

export const SSH_RELAY_ARTIFACT_CACHE_LOCK_RELEASE_LIMITS = Object.freeze({
  retryIntervalMs: RETRY_INTERVAL_MS,
  retryTimeoutMs: RETRY_TIMEOUT_MS
})

export type SshRelayArtifactCacheLockReleaseOperations = Readonly<{
  rename: (sourcePath: string, destinationPath: string) => Promise<void>
  remove: (path: string) => Promise<void>
  wait: () => Promise<void>
  now: () => number
}>

const DEFAULT_OPERATIONS: SshRelayArtifactCacheLockReleaseOperations = Object.freeze({
  rename,
  remove: async (path) => rm(path, { recursive: true, force: true }),
  wait: async () => new Promise<void>((resolveWait) => setTimeout(resolveWait, RETRY_INTERVAL_MS)),
  now: Date.now
})

export async function releaseSshRelayArtifactCacheLockPath(
  {
    lockPath,
    token,
    checkOwnership
  }: {
    lockPath: string
    token: string
    checkOwnership: () => Promise<'owned' | 'displaced'>
  },
  operations: SshRelayArtifactCacheLockReleaseOperations = DEFAULT_OPERATIONS
): Promise<void> {
  if (!TOKEN.test(token)) {
    throw new Error('SSH relay artifact cache lock release token must be exact lowercase hex')
  }
  const tombstone = `${lockPath}.released-${token}`
  const deadline = operations.now() + RETRY_TIMEOUT_MS
  let retrying = false
  while (true) {
    if (retrying && (await checkOwnership()) === 'displaced') {
      return
    }
    try {
      await operations.rename(lockPath, tombstone)
      break
    } catch (error) {
      const code = sshRelayArtifactCacheErrorCode(error)
      if (code === 'ENOENT') {
        return
      }
      if (!WINDOWS_SHARING_ERRORS.has(code ?? '')) {
        throw error
      }
      if (operations.now() >= deadline) {
        throw new Error('SSH relay artifact cache lock release remained blocked by file sharing', {
          cause: error
        })
      }
      await operations.wait()
      // Why: a sharing retry may proceed only while this exact nonce still owns this directory.
      retrying = true
    }
  }
  await operations.remove(tombstone)
}
