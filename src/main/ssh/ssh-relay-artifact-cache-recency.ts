import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { sshRelayArtifactCacheErrorCode } from './ssh-relay-artifact-cache-lock-record'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

const CONTENT_ID = /^sha256:([0-9a-f]{64})$/
const RECORD_NAME = /^(\d{16})-([0-9a-f]{32})\.used$/

function exactContentHex(contentId: SshRelayDigest): string {
  const match = CONTENT_ID.exec(contentId)
  if (!match) {
    throw new Error('SSH relay artifact cache recency content ID must be an exact lowercase digest')
  }
  return match[1]
}

function exactUsedAtMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('SSH relay artifact cache recency time must be a non-negative safe integer')
  }
  return value
}

function recencyDirectory(cacheRoot: string, contentId: SshRelayDigest): string {
  return resolve(cacheRoot, 'recency', exactContentHex(contentId))
}

export async function recordSshRelayArtifactCacheRecency({
  cacheRoot,
  contentId,
  usedAtMs = Date.now()
}: {
  cacheRoot: string
  contentId: SshRelayDigest
  usedAtMs?: number
}): Promise<void> {
  const directory = recencyDirectory(cacheRoot, contentId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const timestamp = String(exactUsedAtMs(usedAtMs)).padStart(16, '0')
  const path = join(directory, `${timestamp}-${randomBytes(16).toString('hex')}.used`)
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  const names = await readdir(directory)
  const valid = names.filter((name) => RECORD_NAME.test(name)).sort()
  const newest = valid.at(-1)
  await Promise.all(
    valid
      .filter((name) => name !== newest)
      .map((name) =>
        rm(join(directory, name), { force: true }).catch((error) => {
          if (sshRelayArtifactCacheErrorCode(error) !== 'ENOENT') {
            throw error
          }
        })
      )
  )
}

export type SshRelayArtifactCacheRecency =
  | { kind: 'known'; usedAtMs: number }
  | { kind: 'ambiguous' }

export async function readSshRelayArtifactCacheRecency({
  cacheRoot,
  contentId,
  initialUsedAtMs
}: {
  cacheRoot: string
  contentId: SshRelayDigest
  initialUsedAtMs: number
}): Promise<SshRelayArtifactCacheRecency> {
  let names: string[]
  try {
    names = await readdir(recencyDirectory(cacheRoot, contentId))
  } catch (error) {
    if (sshRelayArtifactCacheErrorCode(error) === 'ENOENT') {
      return { kind: 'known', usedAtMs: exactUsedAtMs(Math.trunc(initialUsedAtMs)) }
    }
    return { kind: 'ambiguous' }
  }
  let usedAtMs = exactUsedAtMs(Math.trunc(initialUsedAtMs))
  for (const name of names) {
    const match = RECORD_NAME.exec(name)
    if (!match) {
      return { kind: 'ambiguous' }
    }
    const metadata = await lstat(join(recencyDirectory(cacheRoot, contentId), name)).catch(
      () => null
    )
    if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size !== 0) {
      return { kind: 'ambiguous' }
    }
    const timestamp = Number(match[1])
    if (!Number.isSafeInteger(timestamp)) {
      return { kind: 'ambiguous' }
    }
    usedAtMs = Math.max(usedAtMs, timestamp)
  }
  return { kind: 'known', usedAtMs }
}

export async function removeSshRelayArtifactCacheRecency(
  cacheRoot: string,
  contentId: SshRelayDigest
): Promise<void> {
  await rm(recencyDirectory(cacheRoot, contentId), { recursive: true, force: true })
}
