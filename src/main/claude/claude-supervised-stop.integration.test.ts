import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SpawnOptions as SdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import {
  PROVIDER_SIGTERM_GRACE_MS,
  PROVIDER_STDIN_END_GRACE_MS,
  PROVIDER_SUPERVISOR_MAX_STOP_MS
} from '../provider-process/provider-process-supervisor'
import { proveClaudeChildExit } from './claude-agent-sdk-exit-proof'
import { createClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'

// Stands in for Claude mid-turn: stdin end does not stop it, the way EOF lets the real CLI finish
// its turn. Its tool leads its own group, as the CLI's Bash tool shells do, and only Claude's own
// SIGTERM handler reaps it. The daemon double-forks out of the tree before anything looks.
const FAKE_CLAUDE = String.raw`
  const { spawn } = require('node:child_process')
  const { writeFileSync } = require('node:fs')
  process.stdin.resume()
  process.stdout.on('error', () => {})
  const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
    detached: true,
    stdio: 'ignore'
  })
  const forker = spawn(
    process.execPath,
    ['-e', "const d = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { detached: true, stdio: 'ignore' }); d.unref(); process.stdout.write(String(d.pid))"],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  let daemon = ''
  forker.stdout.on('data', (chunk) => { daemon += chunk })
  forker.once('exit', () => {
    process.stdout.write(JSON.stringify({ claude: process.pid, tool: tool.pid, daemon: Number(daemon) }) + '\n')
  })
  process.on('SIGTERM', () => {
    if (process.env.ORCA_TEST_CLAUDE_IGNORES_SIGTERM) return
    try { process.kill(-tool.pid, 'SIGKILL') } catch {}
    writeFileSync(process.env.ORCA_TEST_SIGTERM_MARKER, 'reaped')
    process.exit(143)
  })
  setInterval(() => {}, 60000)
`

// Stands in for Orca's main: starts exactly the spec Claude's spawner built, then can be SIGKILLed.
const OWNER = String.raw`
  const { spawn } = require('node:child_process')
  const spec = JSON.parse(process.env.ORCA_TEST_SPAWN_SPEC)
  const env = { ...spec.env }
  if (env.ORCA_PROVIDER_SUPERVISOR_SPEC) {
    const supervisor = JSON.parse(Buffer.from(env.ORCA_PROVIDER_SUPERVISOR_SPEC, 'base64').toString())
    supervisor.ownerPid = process.pid
    env.ORCA_PROVIDER_SUPERVISOR_SPEC = Buffer.from(JSON.stringify(supervisor)).toString('base64')
  }
  const child = spawn(spec.program, spec.args, {
    cwd: spec.cwd,
    env,
    detached: spec.detached,
    stdio: ['pipe', 'pipe', 'ignore']
  })
  process.stdout.write(JSON.stringify({ root: child.pid }) + '\n')
  child.stdout.pipe(process.stdout)
  setInterval(() => {}, 60000)
`

const recordedPids = new Set<number>()
const tempDirs: string[] = []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

function readPids(child: ChildProcess, keys: readonly string[]): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    const pids: Record<string, number> = {}
    let buffered = ''
    const timeout = setTimeout(() => reject(new Error(`no ${keys.join('/')} pids`)), 10_000)
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString()
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        const parsed: unknown = JSON.parse(line)
        for (const [key, pid] of Object.entries(parsed ?? {})) {
          if (typeof pid === 'number' && pid > 0) {
            pids[key] = pid
            recordedPids.add(pid)
          }
        }
      }
      if (keys.every((key) => key in pids)) {
        clearTimeout(timeout)
        child.stdout!.off('data', onData)
        child.stdout!.resume()
        resolve(pids)
      }
    }
    child.stdout!.on('data', onData)
  })
}

function sdkOptions(env: Record<string, string>): SdkSpawnOptions {
  const dir = mkdtempSync(join(tmpdir(), 'orca-claude-supervised-'))
  tempDirs.push(dir)
  return {
    command: process.execPath,
    args: ['-e', FAKE_CLAUDE],
    cwd: dir,
    env: {
      ...process.env,
      ORCA_TEST_SIGTERM_MARKER: join(dir, 'sigterm-reap'),
      ...env
    },
    signal: new AbortController().signal
  }
}

/** Claude spawned through Orca's own spawner and stopped by Orca's own close ladder. */
async function spawnClaude(env: Record<string, string> = {}) {
  const spawner = createClaudeCodeProcessSpawn(spawnProcess)
  const options = sdkOptions(env)
  const child = spawner.spawn(options)
  recordedPids.add(child.pid!)
  const managed = spawner.managed
  if (!managed) {
    throw new Error('Claude spawner did not retain its managed child')
  }
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    managed.onExit(resolve)
  )
  const pids = await readPids(child, ['claude', 'tool', 'daemon'])
  const close = (): Promise<boolean> => proveClaudeChildExit({ managed })
  return { child, managed, exit, pids, close, marker: String(options.env.ORCA_TEST_SIGTERM_MARKER) }
}

afterEach(() => {
  for (const pid of recordedPids) {
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  }
  recordedPids.clear()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe.runIf(process.platform !== 'win32')('Claude under the POSIX provider supervisor', () => {
  it('stops a mid-turn Claude on close instead of letting stdin end finish its turn', async () => {
    const { child, managed, exit, pids, close, marker } = await spawnClaude()
    expect(child.pid).not.toBe(pids.claude)

    const startedAt = Date.now()
    await expect(close()).resolves.toBe(true)
    expect(managed.lastCloseResult).toEqual({ root: 'exited', tree: 'exited' })
    await expect(close()).resolves.toBe(true)

    // Claude's own SIGTERM reap ran at once, not after the supervisor's stdin-end grace.
    expect(Date.now() - startedAt).toBeLessThan(PROVIDER_STDIN_END_GRACE_MS)
    expect(existsSync(marker)).toBe(true)
    await expect(exit).resolves.toEqual({ code: null, signal: 'SIGTERM', processless: false })
    expect(alive(pids.claude)).toBe(false)
    expect(alive(pids.tool)).toBe(false)
  })

  it('lets the supervisor escalate a Claude that ignores SIGTERM, and exits only after it', async () => {
    const { managed, exit, pids, close } = await spawnClaude({
      ORCA_TEST_CLAUDE_IGNORES_SIGTERM: '1'
    })

    const startedAt = Date.now()
    await expect(close()).resolves.toBe(true)
    expect(managed.lastCloseResult).toEqual({ root: 'exited', tree: 'exited' })
    await expect(close()).resolves.toBe(true)

    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(PROVIDER_SIGTERM_GRACE_MS)
    expect(elapsed).toBeLessThan(PROVIDER_SUPERVISOR_MAX_STOP_MS + 1_000)
    // The supervisor's own SIGTERM stop finished the job; nothing forced the supervisor itself.
    await expect(exit).resolves.toEqual({ code: null, signal: 'SIGTERM', processless: false })
    expect(alive(pids.claude)).toBe(false)
  })

  it("stops Claude and its tool when Orca's main dies, and leaves a daemon that left its tree alone", async () => {
    const specs: ProcessSpec[] = []
    createClaudeCodeProcessSpawn((spec) => {
      specs.push(spec)
      return spawnProcess({ program: 'true' })
    }).spawn(sdkOptions({}))
    const owner = spawn(process.execPath, ['-e', OWNER], {
      env: { ...process.env, ORCA_TEST_SPAWN_SPEC: JSON.stringify(specs[0]) },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    recordedPids.add(owner.pid!)
    const pids = await readPids(owner, ['root', 'claude', 'tool', 'daemon'])

    owner.kill('SIGKILL')

    expect(await waitFor(() => !alive(pids.claude), PROVIDER_SUPERVISOR_MAX_STOP_MS)).toBe(true)
    expect(await waitFor(() => !alive(pids.root), PROVIDER_SUPERVISOR_MAX_STOP_MS)).toBe(true)
    // In its own group, so only Claude's SIGTERM handler could have reaped it.
    expect(alive(pids.tool)).toBe(false)
    // Not the conversation's writer: nothing proves it orphaned, so the stop never reaches it.
    expect(alive(pids.daemon)).toBe(true)
  })
})
