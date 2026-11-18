import { execFileSync } from 'node:child_process'
import * as pty from 'node-pty'
import { expect, it } from 'vitest'
import { forceKillPosixPtyProcessGroups } from './posix-pty-process-groups'
import { readPtsName } from './node-pty-pts-name'

type TaggedProcess = { pid: number; pgid: number }

const itOnPosix = process.platform === 'win32' ? it.skip : it

// Select processes by terminal or pid: a whole-host listing with command lines overflows the buffer on busy machines.
function findTaggedProcesses(selection: string[], token: string): TaggedProcess[] {
  let output: string
  try {
    output = execFileSync('ps', [...selection, '-o', 'pid=,pgid=,state=,command='], {
      encoding: 'utf8'
    })
  } catch (error) {
    // ps exits 1 when nothing matches the selection.
    if (error instanceof Error && 'status' in error && error.status === 1) {
      return []
    }
    throw error
  }
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

// Survivors lose the hung-up terminal, so recheck them by pid; the token rejects reused pids.
function findSurvivors(tagged: TaggedProcess[], token: string): TaggedProcess[] {
  if (tagged.length === 0) {
    return []
  }
  return findTaggedProcesses(['-p', tagged.map((process) => process.pid).join(',')], token)
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

// Runs before the leader is killed, so a job discovery never captured is still on the terminal.
function cleanupTaggedProcesses(tty: string, tagged: TaggedProcess[], token: string): void {
  const remaining = [...findTaggedProcesses(['-t', tty], token), ...findSurvivors(tagged, token)]
  for (const pgid of new Set(remaining.map((process) => process.pgid))) {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      // The tagged test group may already be gone.
    }
  }
}

function readProcessGroup(pid: number): number {
  return Number(execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim())
}

itOnPosix(
  'reaps a foreground job that ignores terminal shutdown signals',
  async () => {
    const token = `ORCA_PTY_GROUP_TEST_${process.pid}_${Date.now()}`
    const proc = pty.spawn('/bin/sh', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>
    })
    const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()))
    const tty = readPtsName(proc)?.replace(/^\/dev\//, '')
    if (!tty) {
      throw new Error('node-pty did not expose the PTY slave name')
    }

    let tagged: TaggedProcess[] = []
    try {
      proc.write(`/bin/sh -lc 'trap "" HUP TERM; while :; do sleep 60; done' ${token}\n`)
      await waitFor(() => findTaggedProcesses(['-t', tty], token).length > 0)

      tagged = findTaggedProcesses(['-t', tty], token)
      const rootProcessGroup = readProcessGroup(proc.pid)
      expect(tagged.some((process) => process.pgid !== rootProcessGroup)).toBe(true)

      await forceKillPosixPtyProcessGroups(proc.pid, () => proc.kill('SIGKILL'))
      await Promise.race([
        exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('PTY leader did not exit')), 5_000)
        )
      ])
      await waitFor(() => findSurvivors(tagged, token).length === 0)
    } finally {
      try {
        cleanupTaggedProcesses(tty, tagged, token)
      } finally {
        try {
          proc.kill('SIGKILL')
        } catch {
          // node-pty may already have reaped and disposed the leader.
        }
      }
    }
  },
  10_000
)
