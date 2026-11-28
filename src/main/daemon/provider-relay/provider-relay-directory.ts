import { lstat, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { spawnManagedProviderProcess } from '../../provider-process/managed-provider-process'
import type { createClaudeChildTreeReaper } from '../../claude/child-process/claude-agent-sdk-exit-proof'

const RELAY_SPOOL_NAME = /^r-(\d+)-[0-9a-f-]{36}\.ndjson(?:\.line|\.compact)?$/

export type ProviderRelayDirectory = {
  directory: string
  spawn: typeof spawnManagedProviderProcess
  reaper: typeof createClaudeChildTreeReaper
}

/** Spawn code loads on the first chat only, so a daemon that never relays starts as fast as before. */
export async function prepareProviderRelayDirectory(
  runtimeDir: string
): Promise<ProviderRelayDirectory> {
  const directory = join(runtimeDir, 'chat-relay')
  const journal = join(directory, 'provider-processes')
  await mkdir(journal, { recursive: true, mode: 0o700 })
  for (const path of [directory, journal]) {
    const info = await lstat(path)
    if (
      !info.isDirectory() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    ) {
      throw new Error('Relay directory is not private')
    }
  }
  const [
    { spawnManagedProviderProcess },
    { installProviderOwnershipDirectory },
    { createClaudeChildTreeReaper }
  ] = await Promise.all([
    import('../../provider-process/managed-provider-process'),
    import('../../provider-process/provider-ownership-journal'),
    import('../../claude/child-process/claude-agent-sdk-exit-proof')
  ])
  installProviderOwnershipDirectory(journal)
  await removeDeadOwnersSpools(directory)
  return { directory, spawn: spawnManagedProviderProcess, reaper: createClaudeChildTreeReaper }
}

/** A spool only its creating daemon can read; once that daemon is proven gone, nobody can. */
async function removeDeadOwnersSpools(directory: string): Promise<void> {
  const names = await readdir(directory).catch(() => [])
  // One probe per owner: a surviving daemon may hold many spools.
  const gone = new Map<number, boolean>()
  for (const name of names) {
    const owner = Number(RELAY_SPOOL_NAME.exec(name)?.[1] ?? process.pid)
    if (owner === process.pid) {
      continue
    }
    if (!gone.has(owner)) {
      gone.set(owner, ownerProvenGone(owner))
    }
    if (gone.get(owner)) {
      await unlink(join(directory, name)).catch(() => {})
    }
  }
}

/** Only a proven-absent pid (ESRCH) frees a spool; "can't tell" keeps it. */
function ownerProvenGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}
