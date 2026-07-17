import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'

import { sshRelayArtifactCacheErrorCode } from './ssh-relay-artifact-cache-lock-record'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

export const SSH_RELAY_ARTIFACT_CACHE_IN_USE_SCHEMA_VERSION = 1
const MAXIMUM_RECORD_BYTES = 16 * 1024

export type SshRelayArtifactCacheInUseOwner = {
  schemaVersion: typeof SSH_RELAY_ARTIFACT_CACHE_IN_USE_SCHEMA_VERSION
  contentId: SshRelayDigest
  token: string
  hostname: string
  pid: number
  acquiredAtMs: number
  heartbeatAtMs: number
}

export type SshRelayArtifactCacheInUseDirectoryIdentity = { dev: bigint; ino: bigint }

function validOwner(
  value: unknown,
  contentId: SshRelayDigest,
  token: string
): value is SshRelayArtifactCacheInUseOwner {
  if (!value || typeof value !== 'object') {
    return false
  }
  const owner = value as Partial<SshRelayArtifactCacheInUseOwner>
  return (
    owner.schemaVersion === SSH_RELAY_ARTIFACT_CACHE_IN_USE_SCHEMA_VERSION &&
    owner.contentId === contentId &&
    owner.token === token &&
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

export function sshRelayArtifactCacheInUseOwnerBytes(
  owner: SshRelayArtifactCacheInUseOwner
): Buffer {
  return Buffer.from(`${JSON.stringify(owner)}\n`, 'utf8')
}

export async function readSshRelayArtifactCacheInUseOwner(
  leasePath: string,
  contentId: SshRelayDigest,
  token: string
): Promise<SshRelayArtifactCacheInUseOwner | null> {
  const path = join(leasePath, 'owner.json')
  let metadata
  try {
    metadata = await lstat(path, { bigint: true })
  } catch (error) {
    if (sshRelayArtifactCacheErrorCode(error) === 'ENOENT') {
      return null
    }
    throw error
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAXIMUM_RECORD_BYTES) {
    return null
  }
  const handle = await open(path, 'r')
  try {
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    ) {
      return null
    }
    const bytes = Buffer.alloc(Number(opened.size))
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const after = await handle.stat({ bigint: true })
    if (
      bytesRead !== bytes.length ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      return null
    }
    let input: unknown
    try {
      input = JSON.parse(bytes.toString('utf8'))
    } catch {
      return null
    }
    return validOwner(input, contentId, token) ? input : null
  } finally {
    await handle.close()
  }
}

export function sameSshRelayArtifactCacheInUseDirectory(
  left: SshRelayArtifactCacheInUseDirectoryIdentity,
  right: SshRelayArtifactCacheInUseDirectoryIdentity
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}
