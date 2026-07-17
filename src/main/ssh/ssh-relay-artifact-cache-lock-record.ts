import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SshRelayDigest } from './ssh-relay-runtime-identity'

export const SSH_RELAY_ARTIFACT_CACHE_LOCK_SCHEMA_VERSION = 1

export type SshRelayArtifactCacheLockOwnerRecord = {
  schemaVersion: typeof SSH_RELAY_ARTIFACT_CACHE_LOCK_SCHEMA_VERSION
  contentId: SshRelayDigest
  token: string
  hostname: string
  pid: number
  acquiredAtMs: number
  heartbeatAtMs: number
}

export type SshRelayArtifactCacheLockDirectoryIdentity = { dev: bigint; ino: bigint }

export function sshRelayArtifactCacheErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined
}

function validOwner(
  value: unknown,
  contentId: SshRelayDigest
): value is SshRelayArtifactCacheLockOwnerRecord {
  if (!value || typeof value !== 'object') {
    return false
  }
  const owner = value as Partial<SshRelayArtifactCacheLockOwnerRecord>
  return (
    owner.schemaVersion === SSH_RELAY_ARTIFACT_CACHE_LOCK_SCHEMA_VERSION &&
    owner.contentId === contentId &&
    typeof owner.token === 'string' &&
    /^[0-9a-f]{32}$/.test(owner.token) &&
    typeof owner.hostname === 'string' &&
    owner.hostname.length > 0 &&
    typeof owner.pid === 'number' &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.acquiredAtMs === 'number' &&
    Number.isSafeInteger(owner.acquiredAtMs) &&
    owner.acquiredAtMs >= 0 &&
    typeof owner.heartbeatAtMs === 'number' &&
    Number.isSafeInteger(owner.heartbeatAtMs) &&
    owner.heartbeatAtMs >= owner.acquiredAtMs
  )
}

export function sshRelayArtifactCacheLockOwnerBytes(
  owner: SshRelayArtifactCacheLockOwnerRecord
): Buffer {
  return Buffer.from(`${JSON.stringify(owner)}\n`, 'utf8')
}

export async function readSshRelayArtifactCacheLockOwner(
  lockPath: string,
  contentId: SshRelayDigest
): Promise<SshRelayArtifactCacheLockOwnerRecord | null> {
  try {
    const bytes = await readFile(join(lockPath, 'owner.json'), 'utf8')
    const parsed: unknown = JSON.parse(bytes)
    return validOwner(parsed, contentId) ? parsed : null
  } catch (error) {
    if (sshRelayArtifactCacheErrorCode(error) === 'ENOENT' || error instanceof SyntaxError) {
      return null
    }
    throw error
  }
}

export function sameSshRelayArtifactCacheLockDirectory(
  left: SshRelayArtifactCacheLockDirectoryIdentity,
  right: SshRelayArtifactCacheLockDirectoryIdentity
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}
