import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

// A stand-in agent CLI that, like `opencode serve` or a wedged Codex, ignores its stdin end. It
// leaves a SIGTERM-ignoring grandchild in its group, so only a group SIGKILL ends everything, and
// records its stdin end and a SIGTERM (exiting on the latter). `body` adds the caller's protocol.
function standInSource(body: string): string {
  return String.raw`
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const record = (event) =>
  fs.appendFileSync(process.env.ORCA_TEST_EVENTS_FILE, JSON.stringify({ event, at: Date.now() }) + '\n')
process.on('SIGTERM', () => {
  record('SIGTERM')
  fs.writeFileSync(process.env.ORCA_TEST_SIGNAL_FILE, 'SIGTERM')
  process.exit(0)
})
process.stdin.on('error', () => {}).on('end', () => record('stdin-end')).resume()
const grandchild = spawn(
  process.execPath,
  ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('armed'); setInterval(() => {}, 60000)"],
  { stdio: ['ignore', 'pipe', 'ignore'] }
)
grandchild.stdout.once('data', () => {
  // Renamed into place, so a reader never sees a half-written file.
  const partial = process.env.ORCA_TEST_PID_FILE + '.partial'
  fs.writeFileSync(partial, JSON.stringify({ provider: process.pid, grandchild: grandchild.pid }))
  fs.renameSync(partial, process.env.ORCA_TEST_PID_FILE)
})
setInterval(() => {}, 60000)
${body}
`
}

export type StandInEvent = { event: 'stdin-end' | 'SIGTERM'; at: number }

export type SupervisedProbeRig = {
  dir: string
  pidFile: string
  signalFile: string
  /** When the stand-in saw its stdin end and its SIGTERM, by its own clock (this host's). */
  readEvents: () => Partial<Record<StandInEvent['event'], number>>
  env: Record<string, string>
  /** An executable stand-in, run as `<path> <args>` like a real agent CLI. */
  writeStandIn: (name: string, body?: string) => string
  /** Bundles a TypeScript owner entry, resolved from `resolveDir`, into one plain-Node file. */
  bundleOwner: (source: string, resolveDir: string) => Promise<string>
  launchOwner: (bundle: string, env?: Record<string, string>) => ChildProcess
  readPids: (timeoutMs?: number) => Promise<{ provider: number; grandchild: number }>
  cleanup: () => void
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

export function createSupervisedProbeRig(): SupervisedProbeRig {
  const dir = mkdtempSync(join(tmpdir(), 'orca-supervised-probe-'))
  const pidFile = join(dir, 'pids.json')
  const signalFile = join(dir, 'signal')
  const eventsFile = join(dir, 'events.jsonl')
  const recordedPids = new Set<number>()
  const env = {
    ORCA_TEST_PID_FILE: pidFile,
    ORCA_TEST_SIGNAL_FILE: signalFile,
    ORCA_TEST_EVENTS_FILE: eventsFile
  }
  return {
    dir,
    pidFile,
    signalFile,
    readEvents: () => {
      const events: Partial<Record<StandInEvent['event'], number>> = {}
      const lines = existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8').split('\n') : []
      for (const line of lines.filter(Boolean)) {
        const { event, at }: StandInEvent = JSON.parse(line)
        events[event] ??= at
      }
      return events
    },
    env,
    writeStandIn: (name, body = '') => {
      const script = join(dir, `${name}.cjs`)
      writeFileSync(script, standInSource(body))
      const launcher = join(dir, name)
      writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
      chmodSync(launcher, 0o755)
      return launcher
    },
    bundleOwner: async (source, resolveDir) => {
      const outfile = join(dir, 'owner.cjs')
      await build({
        stdin: { contents: source, resolveDir, loader: 'ts', sourcefile: 'owner.ts' },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        outfile,
        logLevel: 'silent'
      })
      return outfile
    },
    launchOwner: (bundle, ownerEnv = {}) => {
      const owner = spawn(process.execPath, [bundle], {
        env: { ...process.env, ...env, ...ownerEnv },
        stdio: 'ignore'
      })
      recordedPids.add(owner.pid!)
      return owner
    },
    readPids: async (timeoutMs = 20_000) => {
      if (!(await waitFor(() => existsSync(pidFile), timeoutMs))) {
        throw new Error('the stand-in never reported its pids')
      }
      const pids: { provider: number; grandchild: number } = JSON.parse(
        readFileSync(pidFile, 'utf8')
      )
      recordedPids.add(pids.provider)
      recordedPids.add(pids.grandchild)
      return pids
    },
    cleanup: () => {
      // Only pids this rig recorded, so a failed run never leaves a stand-in behind.
      for (const pid of recordedPids) {
        if (alive(pid)) {
          process.kill(pid, 'SIGKILL')
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
