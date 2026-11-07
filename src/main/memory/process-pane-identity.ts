import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { runProcess } from '@orca/process-host'
import { darwinProcessHelperPath } from './darwin-process-footprint'

/** The workspace and pane every Orca terminal writes into the environment of what it starts. */
export type ProcessPaneIdentity = { worktreeId: string; paneKey: string | null }

// A pid names the same process only while sweeps run back to back; after a pause it may be reused.
const CACHE_PAUSE_MS = 10_000
const LINUX_READ_BATCH = 32
const HELPER_TIMEOUT_MS = 5_000
const HELPER_MAX_OUTPUT = 4 * 1024 * 1024

let cache = new Map<number, ProcessPaneIdentity | null>()
let lastReadAt = 0

/** Identities of these live pids. Each process is read once; Windows reads none. */
export async function readProcessPaneIdentities(
  pids: readonly number[]
): Promise<Map<number, ProcessPaneIdentity>> {
  const now = Date.now()
  if (now - lastReadAt > CACHE_PAUSE_MS) {
    cache = new Map()
  }
  lastReadAt = now
  const live = new Set(pids)
  for (const pid of cache.keys()) {
    if (!live.has(pid)) {
      cache.delete(pid)
    }
  }
  const unread = pids.filter((pid) => !cache.has(pid))
  const read = unread.length > 0 ? await readUncached(unread) : null
  if (read) {
    for (const pid of unread) {
      cache.set(pid, read.get(pid) ?? null)
    }
  }
  const identities = new Map<number, ProcessPaneIdentity>()
  for (const pid of pids) {
    const identity = cache.get(pid)
    if (identity) {
      identities.set(pid, identity)
    }
  }
  return identities
}

async function readUncached(pids: number[]): Promise<Map<number, ProcessPaneIdentity> | null> {
  const platform = os.platform()
  if (platform === 'darwin') {
    return readWithHelper(pids)
  }
  if (platform === 'linux') {
    return readProcEnviron(pids)
  }
  // Reading another process's environment on Windows means reading its memory.
  return null
}

async function readWithHelper(pids: number[]): Promise<Map<number, ProcessPaneIdentity> | null> {
  const helper = darwinProcessHelperPath()
  if (!helper) {
    return null
  }
  try {
    const result = await runProcess({
      program: helper,
      args: ['--pane-identity', ...pids.map(String)],
      maxOutputBytes: HELPER_MAX_OUTPUT,
      timeoutMs: HELPER_TIMEOUT_MS
    })
    return result.code === 0 && !result.timedOut ? parseHelperPaneIdentities(result.stdout) : null
  } catch {
    return null
  }
}

function parseHelperPaneIdentities(stdout: string): Map<number, ProcessPaneIdentity> {
  const identities = new Map<number, ProcessPaneIdentity>()
  for (const line of stdout.split('\n')) {
    const match = /^(\d+)\t([^\t]+)\t([^\t]*)$/.exec(line)
    if (match) {
      identities.set(Number.parseInt(match[1], 10), {
        worktreeId: match[2],
        paneKey: match[3] || null
      })
    }
  }
  return identities
}

async function readProcEnviron(pids: number[]): Promise<Map<number, ProcessPaneIdentity>> {
  const identities = new Map<number, ProcessPaneIdentity>()
  for (let start = 0; start < pids.length; start += LINUX_READ_BATCH) {
    await Promise.all(
      pids.slice(start, start + LINUX_READ_BATCH).map(async (pid) => {
        try {
          const identity = identityFromEnviron(await readFile(`/proc/${pid}/environ`, 'utf8'))
          if (identity) {
            identities.set(pid, identity)
          }
        } catch {
          // Another user's process, or one that has exited.
        }
      })
    )
  }
  return identities
}

function identityFromEnviron(environ: string): ProcessPaneIdentity | null {
  let worktreeId = ''
  let paneKey: string | null = null
  for (const entry of environ.split('\0')) {
    if (entry.startsWith('ORCA_WORKTREE_ID=')) {
      worktreeId = entry.slice('ORCA_WORKTREE_ID='.length)
    } else if (entry.startsWith('ORCA_PANE_KEY=')) {
      paneKey = entry.slice('ORCA_PANE_KEY='.length) || null
    }
  }
  return worktreeId ? { worktreeId, paneKey } : null
}
