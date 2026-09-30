import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SpawnOptions as SdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { resolveSpawn, type spawnProcess } from '../../shared/child-process/run-process'
import type { ProcessSpec } from '../../shared/child-process/process-spec'
import type * as ProviderSupervisor from '../codex/codex-app-server-posix-supervisor'
import { createProviderSpawnSpec } from '../codex/codex-app-server-posix-supervisor'
import { createClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'
import { proveClaudeChildExitWithReaper } from './claude-child-exit-proof-ladder'

vi.mock('../codex/codex-app-server-posix-supervisor', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderSupervisor>()
  return { ...actual, createProviderSpawnSpec: vi.fn(actual.createProviderSpawnSpec) }
})

type FakeChild = EventEmitter & {
  pid: number
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals | number) => boolean>>
}

function fakeSpawn() {
  const child = new EventEmitter() as FakeChild
  child.pid = 4321
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn((_signal?: NodeJS.Signals | number) => true)
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
    const spawn = createClaudeCodeProcessSpawn(process.spawnImpl, 'win32')

    expect(spawn.pid).toBeUndefined()
    expect(spawn.child).toBeNull()
    const child = spawn.spawn(sdkOptions())

    expect(child).toBe(process.child)
    expect(spawn.child).toBe(process.child)
    expect(spawn.pid).toBe(4321)
    // Windows has no supervisor: Claude itself is the child.
    expect(spawn.supervised).toBe(false)
    expect(process.specs[0]).toEqual({
      program: '/usr/local/bin/claude',
      args: ['--output-format', 'stream-json'],
      cwd: '/work/repo',
      env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/accounts/one' },
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
  })

  it.each(['darwin', 'linux'] as const)(
    'starts Claude under the provider supervisor on %s, which is then the pid the lease records',
    (platform) => {
      const process = fakeSpawn()
      const spawn = createClaudeCodeProcessSpawn(process.spawnImpl, platform)
      spawn.spawn(sdkOptions())

      const [spec] = process.specs
      if (!spec) {
        throw new Error('the spawner never built a spec')
      }
      expect(spawn.supervised).toBe(true)
      expect(spawn.pid).toBe(4321)
      expect(spec.program).toBe(globalThis.process.execPath)
      expect(spec.args?.[0]).toBe('-e')
      expect(spec.detached).toBe(true)
      expect(spec.cwd).toBe('/work/repo')
      const supervisorSpec = JSON.parse(
        Buffer.from(String(spec.env?.ORCA_PROVIDER_SUPERVISOR_SPEC), 'base64').toString()
      )
      expect(supervisorSpec).toMatchObject({
        command: '/usr/local/bin/claude',
        args: ['--output-format', 'stream-json'],
        cwd: '/work/repo',
        ownerPid: globalThis.process.pid
      })
      // The supervisor passes its env to Claude minus its own two keys.
      expect(spec.env).toMatchObject({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/accounts/one' })
    }
  )

  it.each([
    { platform: 'darwin', specSupervised: false },
    { platform: 'win32', specSupervised: true }
  ] as const)(
    'stops Claude by the spawn spec\u2019s supervision on $platform, never the platform',
    async ({ platform, specSupervised }) => {
      const actual = await vi.importActual<typeof ProviderSupervisor>(
        '../codex/codex-app-server-posix-supervisor'
      )
      vi.mocked(createProviderSpawnSpec).mockImplementationOnce((...args) => ({
        ...actual.createProviderSpawnSpec(...args),
        supervised: specSupervised
      }))
      const process = fakeSpawn()
      const spawn = createClaudeCodeProcessSpawn(process.spawnImpl, platform)
      spawn.spawn(sdkOptions())
      expect(spawn.supervised).toBe(specSupervised)

      let exited = false
      let settle = (): void => {}
      const exitPromise = new Promise<void>((resolve) => {
        settle = resolve
      })
      // Claude leaves shortly after stdin ends, so the ladder never needs its forced rung.
      process.child.stdin.on('finish', () =>
        setTimeout(() => {
          exited = true
          settle()
        }, 10)
      )
      const tree = {
        capture: vi.fn(async () => {}),
        reap: vi.fn(async () => 'exited' as const),
        treeVerdict: 'exited' as const
      }
      await proveClaudeChildExitWithReaper(
        {
          child: process.child,
          exitPromise,
          exited: () => exited,
          tree,
          supervised: spawn.supervised
        },
        () => tree
      )
      // SIGTERM to an unsupervised Claude on Windows is TerminateProcess; a skipped one leaves it running.
      if (specSupervised) {
        expect(process.child.kill).toHaveBeenCalledWith('SIGTERM')
      } else {
        expect(process.child.kill).not.toHaveBeenCalled()
      }
    }
  )

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
    createClaudeCodeProcessSpawn(process.spawnImpl, 'win32').spawn(
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
