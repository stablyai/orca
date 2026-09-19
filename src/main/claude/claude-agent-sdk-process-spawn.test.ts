import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SpawnOptions as SdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { resolveSpawn, type spawnProcess } from '../../shared/child-process/run-process'
import type { ProcessSpec } from '../../shared/child-process/process-spec'
import { createClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'

type FakeChild = EventEmitter & {
  pid: number
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}

function fakeSpawn() {
  const child = new EventEmitter() as FakeChild
  child.pid = 4321
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => true)
  const specs: ProcessSpec[] = []
  const spawnImpl = ((spec: ProcessSpec) => {
    specs.push(spec)
    return child
  }) as unknown as typeof spawnProcess
  return { child, spawnImpl, specs }
}

function sdkOptions(overrides: Partial<SdkSpawnOptions> = {}): SdkSpawnOptions {
  return {
    command: '/usr/local/bin/claude',
    args: ['--output-format', 'stream-json'],
    cwd: '/work/repo',
    env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/accounts/one', UNSET: undefined },
    signal: new AbortController().signal,
    ...overrides
  }
}

describe('claude agent SDK process spawn', () => {
  it('routes the SDK spawn through Orca and retains the pid the lease adjudicates on', () => {
    const process = fakeSpawn()
    const spawn = createClaudeCodeProcessSpawn(process.spawnImpl)

    expect(spawn.pid).toBeUndefined()
    expect(spawn.child).toBeNull()
    const child = spawn.spawn(sdkOptions())

    expect(child).toBe(process.child)
    expect(spawn.child).toBe(process.child)
    expect(spawn.pid).toBe(4321)
    expect(process.specs[0]).toEqual({
      program: '/usr/local/bin/claude',
      args: ['--output-format', 'stream-json'],
      cwd: '/work/repo',
      env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/accounts/one' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
  })

  it('keeps the child out of the SDK abort path so exit proof stays Orca-owned', () => {
    const process = fakeSpawn()
    const controller = new AbortController()
    createClaudeCodeProcessSpawn(process.spawnImpl).spawn(sdkOptions({ signal: controller.signal }))

    // Node's spawn({signal}) kills the child on abort; Orca's ladder must be the
    // only thing that can end this process, or close() would report an assumed exit.
    expect(process.specs[0]).not.toHaveProperty('signal')
  })

  it('drains stderr into a bounded tail so an exit error still carries it', async () => {
    const process = fakeSpawn()
    const spawn = createClaudeCodeProcessSpawn(process.spawnImpl)
    spawn.spawn(sdkOptions())

    process.child.stderr.write('x'.repeat(9000))
    process.child.stderr.write('claude: not signed in')
    await new Promise((resolve) => setImmediate(resolve))

    expect(spawn.stderrTail).toMatch(/claude: not signed in$/)
    expect(spawn.stderrTail.length).toBe(8192)
  })

  it('hands a Windows .cmd shim to Orca\u2019s argument encoder', () => {
    const process = fakeSpawn()
    createClaudeCodeProcessSpawn(process.spawnImpl).spawn(
      sdkOptions({
        command: 'C:\\Users\\dev\\AppData\\npm\\claude.cmd',
        args: ['--setting-sources=user,project,local', '--session-id', 'a b&c']
      })
    )

    // The spec the spawner builds is what Orca's Windows branch encodes; the SDK's
    // own spawn would hand `.cmd` straight to Node and mangle the argument.
    const resolved = resolveSpawn(process.specs[0] as ProcessSpec, 'win32')
    expect(resolved.file.toLowerCase()).toContain('cmd.exe')
    expect(resolved.options.windowsVerbatimArguments).toBe(true)
    expect(resolved.args).toHaveLength(1)
    // `/v:off` plus the quoted argument is what keeps `&` from splitting the line.
    expect(resolved.args[0]).toContain('/v:off')
    expect(resolved.args[0]).toContain('"a b&c"')
    expect(resolved.args[0]).toContain('"--setting-sources=user,project,local"')
  })
})
