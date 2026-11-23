import { basename } from 'node:path'
import { readTerminalPs } from '../pty/process-retirement/terminal-process-rows'

const PROVIDER_OWNER_EXECUTABLE = 'orca-provider-exec'

/** The process's own executable name and its parent. */
async function processRow(pid: number): Promise<{ ppid: number; executable: string } | null> {
  const row = (await readTerminalPs(['-o', 'ppid=,args=', '-p', String(pid)]))?.trim()
  const match = row ? /^(\d+)\s+(\S+)/.exec(row) : null
  return match ? { ppid: Number(match[1]), executable: basename(match[2]) } : null
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
export async function providerOwnerHeldElsewhere(pid: number): Promise<boolean | null> {
  const agent = await processRow(pid)
  if (!agent) {
    return null
  }
  // The native owner is the agent's parent, or its grandparent behind a compatibility launcher.
  let ancestor = agent.ppid
  for (let depth = 0; depth < 2 && ancestor > 1; depth += 1) {
    const row = await processRow(ancestor)
    if (!row) {
      return false
    }
    if (row.executable.startsWith(PROVIDER_OWNER_EXECUTABLE)) {
      return row.ppid > 1 && row.ppid !== process.pid && alive(row.ppid)
    }
    ancestor = row.ppid
  }
  return false
}
