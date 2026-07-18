import { execFileSync } from 'node:child_process'
import * as pty from 'node-pty'
import { expect, it } from 'vitest'
import { forceKillPosixPtyProcessGroups } from './posix-pty-process-groups'

type TaggedProcess = { pid: number; pgid: number }

const itOnPosix = process.platform === 'win32' ? it.skip : it

function findTaggedProcesses(token: string): TaggedProcess[] {
  const output = execFileSync('ps', ['-axo', 'pid=,pgid=,state=,command='], {
    encoding: 'utf8'
  })
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

    try {
      proc.write(`/bin/sh -lc 'trap "" HUP TERM; while :; do sleep 60; done' ${token}\n`)
      await waitFor(() => findTaggedProcesses(token).length > 0)

      const tagged = findTaggedProcesses(token)
      const rootProcessGroup = readProcessGroup(proc.pid)
      expect(tagged.some((process) => process.pgid !== rootProcessGroup)).toBe(true)

      forceKillPosixPtyProcessGroups(proc.pid, () => proc.kill('SIGKILL'))
      await Promise.race([
        exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('PTY leader did not exit')), 5_000)
        )
      ])
      await waitFor(() => findTaggedProcesses(token).length === 0)
    } finally {
      cleanupTaggedProcesses(token)
      try {
        proc.kill('SIGKILL')
      } catch {
        // node-pty may already have reaped and disposed the leader.
      }
    }
  },
  10_000
)
