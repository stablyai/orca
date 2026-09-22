import { execFileSync } from 'node:child_process'
import * as pty from 'node-pty'
import { expect, it } from 'vitest'
import { sweepSessionDescendants } from './pty-session-descendant-sweep'
import { readProcessTable } from './pty-descendant-termination'
import {
  createPtySessionProcessIdentity,
  markPtySessionRootExited,
  observePtySessionIdentity
} from './pty-session-identity'
import {
  getCheapProcessTableSnapshot,
  resetCheapProcessTableSnapshotForTests
} from '../shared/cheap-process-table-snapshot-reader'
import { observeLiveSessionProcessIdentities } from './daemon/terminal-host-session-identity-observation'
import { readPtsName } from './pty/node-pty-pts-name'

const itOnPosix = process.platform === 'win32' ? it.skip : it

function findTaggedPids(token: string): number[] {
  let output = ''
  try {
    output = execFileSync('ps', ['-axo', 'pid=,state=,command='], { encoding: 'utf8' })
  } catch {
    return []
  }
  const pids: number[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    // A zombie is already dead and cannot be a survivor.
    if (match && match[3].includes(token) && !match[2].includes('Z')) {
      pids.push(Number(match[1]))
    }
  }
  return pids
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for PTY process state')
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function killTagged(token: string): void {
  for (const pid of findTaggedPids(token)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The tagged process may already be gone.
    }
  }
}

function definedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

/**
 * Spawns a PTY whose shell backgrounds a job into its own process group. The job
 * refuses every signal Orca can be polite with, keeps the session's terminal, and
 * reparents to pid 1 the moment the shell leaves — the shape of the tool shell
 * that survived a week at 85% CPU after its agent's session ended.
 */
async function spawnSessionWithEscapedJob(token: string): Promise<{
  proc: pty.IPty
  identity: ReturnType<typeof createPtySessionProcessIdentity>
  exited: Promise<void>
}> {
  const proc = pty.spawn('/bin/sh', ['-m'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: definedEnv()
  })
  const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()))
  const identity = createPtySessionProcessIdentity({
    rootPid: proc.pid,
    ...(readPtsName(proc) ? { slavePath: readPtsName(proc) } : {})
  })
  proc.write(`/bin/sh -c 'trap "" HUP TERM INT; while :; do sleep 60; done' ${token} &\n`)
  await waitFor(() => findTaggedPids(token).length > 0)
  // ps reports whole seconds: a job observed in its birth second cannot prove it predates the observation.
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  // Stands in for the post-spawn capture that records the root's own coordinates.
  const own = await readProcessTable()
  observePtySessionIdentity(identity, own.rows, own.capturedAtMs)
  // The job's group is learned the way a live TerminalHost learns it: from a shared host capture.
  const stop = observeLiveSessionProcessIdentities(
    new Map([['session', { isAlive: true, processIdentity: identity }]])
  )
  try {
    resetCheapProcessTableSnapshotForTests()
    await getCheapProcessTableSnapshot()
  } finally {
    stop()
  }
  return { proc, identity, exited }
}

const SWEEP_DEPS = { graceMs: 300, verifyMs: 6_000, keepAlive: true }

itOnPosix(
  'reaps a job that outlived a natural PTY exit in its own process group',
  async () => {
    const token = `ORCA_EXIT_SWEEP_TEST_${process.pid}_${Date.now()}`
    const { proc, identity, exited } = await spawnSessionWithEscapedJob(token)
    try {
      // The shell leaves on its own: nothing signals the root, so nothing signals
      // what it left behind. This is the path that had no sweep at all.
      proc.write('exit\n')
      await exited
      markPtySessionRootExited(identity)
      expect(findTaggedPids(token).length).toBeGreaterThan(0)

      await sweepSessionDescendants(identity, SWEEP_DEPS)

      expect(findTaggedPids(token)).toEqual([])
    } finally {
      killTagged(token)
      try {
        proc.kill('SIGKILL')
      } catch {
        // node-pty may already have reaped the leader.
      }
    }
  },
  30_000
)

itOnPosix(
  'reaps the same job when the session is killed instead',
  async () => {
    const token = `ORCA_KILL_SWEEP_TEST_${process.pid}_${Date.now()}`
    const { proc, identity, exited } = await spawnSessionWithEscapedJob(token)
    try {
      const sweep = sweepSessionDescendants(identity, SWEEP_DEPS)
      proc.kill('SIGKILL')
      await exited
      markPtySessionRootExited(identity)
      await sweep

      expect(findTaggedPids(token)).toEqual([])
    } finally {
      killTagged(token)
      try {
        proc.kill('SIGKILL')
      } catch {
        // node-pty may already have reaped the leader.
      }
    }
  },
  30_000
)
