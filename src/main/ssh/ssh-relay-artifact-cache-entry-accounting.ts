import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const SSH_RELAY_ARTIFACT_CACHE_MAXIMUM_MEMBERS_PER_ENTRY = 10_000

function safeAdd(left: number, right: bigint): number | null {
  if (right < 0n || right > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null
  }
  const total = left + Number(right)
  return Number.isSafeInteger(total) ? total : null
}

export async function measureSshRelayArtifactCacheEntryLogicalBytes(
  root: string,
  signal: AbortSignal
): Promise<number | null> {
  const pending = [root]
  let members = 0
  let bytes = 0
  while (pending.length > 0) {
    signal.throwIfAborted()
    if (++members > SSH_RELAY_ARTIFACT_CACHE_MAXIMUM_MEMBERS_PER_ENTRY) {
      return null
    }
    const path = pending.pop()!
    const before = await lstat(path, { bigint: true }).catch(() => null)
    if (!before || before.isSymbolicLink()) {
      return null
    }
    if (before.isFile()) {
      const next = safeAdd(bytes, before.size)
      if (next === null) {
        return null
      }
      bytes = next
      const after = await lstat(path, { bigint: true }).catch(() => null)
      if (
        !after?.isFile() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      ) {
        return null
      }
      continue
    }
    if (!before.isDirectory()) {
      return null
    }
    const names = await readdir(path)
    pending.push(...names.map((name) => join(path, name)))
    const after = await lstat(path, { bigint: true }).catch(() => null)
    if (
      !after?.isDirectory() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      return null
    }
  }
  return bytes
}
