import { basename } from 'node:path'
import { readTerminalPs } from '../pty/process-retirement/terminal-process-rows'
import { readOwnLinuxProcesses } from '../codex/app-server/shared-servers/codex-shared-lease-process-scan'

// Linux keeps 15 characters of a process name, so `orca-provider-exec` reads `orca-provider-e`.
const PROVIDER_OWNER_NAME_PREFIX = 'orca-provider-e'

type ProcessRow = { ppid: number; executable: string }
export type ProviderOwnerProcessRows = (pid: number) => Promise<ProcessRow | null>

/** The process's own executable name and its parent, one `ps -p` each (in-process on macOS). */
async function psRow(pid: number): Promise<ProcessRow | null> {
  const row = (await readTerminalPs(['-o', 'ppid=,args=', '-p', String(pid)]))?.trim()
  const match = row ? /^(\d+)\s+(\S+)/.exec(row) : null
  return match ? { ppid: Number(match[1]), executable: basename(match[2]) } : null
}

/** Rows for one batch of owners: on Linux one read of this user's process table, not a spawn per row. */
export function providerOwnerProcessRows(): ProviderOwnerProcessRows {
  if (process.platform !== 'linux') {
    return psRow
  }
  let table: ReturnType<typeof readOwnLinuxProcesses> | null = null
  return async (pid) => {
    table ??= readOwnLinuxProcesses().catch(() => null)
    const own = await table
    if (!own) {
      return psRow(pid)
    }
    const row = own.get(pid)
    return row ? { ppid: row.parent ?? 0, executable: row.name } : null
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM is a live process owned by someone else.
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/**
 * True when the agent's native owner still has a live parent other than this app: the terminal
 * daemon that kept it running (or another Orca). An orphan's owner is reparented to init, or gone.
 * Null when the process table can't be read.
 */
export async function providerOwnerHeldElsewhere(
  pid: number,
  rows: ProviderOwnerProcessRows = providerOwnerProcessRows()
): Promise<boolean | null> {
  if (!alive(pid)) {
    return false
  }
  const agent = await rows(pid)
  if (!agent) {
    return null
  }
  // The native owner is the agent's parent, or its grandparent behind a compatibility launcher.
  let ancestor = agent.ppid
  for (let depth = 0; depth < 2 && ancestor > 1; depth += 1) {
    const row = await rows(ancestor)
    if (!row) {
      return false
    }
    if (row.executable.startsWith(PROVIDER_OWNER_NAME_PREFIX)) {
      return row.ppid > 1 && row.ppid !== process.pid && alive(row.ppid)
    }
    ancestor = row.ppid
  }
  return false
}
