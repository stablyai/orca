import { runProcessSync } from '../../shared/child-process/run-process'
import { spawnBunPty } from '../daemon/pty-subprocess/bun-pty-process'
import { forceKillPosixPtyProcessGroups } from './posix-pty-process-groups'

type TaggedProcess = { pid: number; pgid: number }

function readPs(args: string[]): string {
  const result = runProcessSync({ program: 'ps', args, timeoutMs: 2_000 })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error(
      `PTY fixture process table is unavailable (exit=${result.code}, timeout=${result.timedOut}, truncated=${result.outputTruncated}): ${result.stderr}`
    )
  }
  return result.stdout
}

function findTaggedProcesses(token: string): TaggedProcess[] {
  // BusyBox uses nonempty headers as exact widths; retain the default command width.
  const output = readPs(['-e', '-o', 'pid=PROCESS_ID,pgid=PROCESS_GID,stat=PROCESS_STATE,args='])
  const matches: TaggedProcess[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes(token)) {
      continue
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+/.exec(line)
    if (match && !match[3].includes('Z')) {
      matches.push({ pid: Number(match[1]), pgid: Number(match[2]) })
    }
  }
  return matches
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  intervalMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for PTY process state')
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

function cleanupTaggedProcesses(token: string): void {
  for (const pgid of new Set(findTaggedProcesses(token).map((process) => process.pgid))) {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      // The tagged test group may already be gone.
    }
  }
}

function readProcessGroup(pid: number): number {
  const rows = readPs(['-e', '-o', 'pid=PROCESS_ID,pgid=PROCESS_GID'])
  for (const row of rows.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(row)
    if (match && Number(match[1]) === pid) {
      return Number(match[2])
    }
  }
  throw new Error('PTY fixture root process group is unavailable')
}

export async function reapPosixForegroundJob(): Promise<{
  separateForegroundGroup: boolean
  leaderExited: boolean
  remainingTaggedProcesses: number
}> {
  const token = `ORCA_PTY_GROUP_TEST_${process.pid}_${Date.now()}`
  const proc = spawnBunPty({
    file: '/bin/sh',
    args: [],
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
  })
  let leaderExited = false
  const exitSubscription = proc.onExit(() => {
    leaderExited = true
  })
  const dataSubscription = proc.onData(() => {})
  try {
    await proc.waitForSpawn?.()
    proc.write(`/bin/sh -lc 'trap "" HUP TERM; while :; do sleep 60; done' ${token}\n`)
    await waitFor(() => findTaggedProcesses(token).length > 0)
    const rootProcessGroup = readProcessGroup(proc.pid)
    const separateForegroundGroup = findTaggedProcesses(token).some(
      (process) => process.pgid !== rootProcessGroup
    )
    forceKillPosixPtyProcessGroups(proc.pid, () => proc.kill('SIGKILL'))
    await waitFor(() => leaderExited)
    await waitFor(() => findTaggedProcesses(token).length === 0)
    return {
      separateForegroundGroup,
      leaderExited,
      remainingTaggedProcesses: findTaggedProcesses(token).length
    }
  } finally {
    exitSubscription.dispose()
    dataSubscription.dispose()
    cleanupTaggedProcesses(token)
    try {
      proc.kill('SIGKILL')
    } catch {
      // The PTY leader may already have exited.
    }
  }
}
