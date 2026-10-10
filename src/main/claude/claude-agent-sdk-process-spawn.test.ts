import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { describe, expect, it, vi } from 'vitest'
import type { SpawnOptions as SdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type { PipedProcessSpawner, ProcessSpec } from '@orca/process-host/process-spec'

import type * as ProviderSupervisor from '../provider-process/provider-process-supervisor'
import { createProviderSpawnSpec } from '../provider-process/provider-process-supervisor'
import { createClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'
import { proveClaudeChildExitWithReaper } from './claude-child-exit-proof-ladder'

vi.mock('../provider-process/provider-process-supervisor', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderSupervisor>()
  return { ...actual, createProviderSpawnSpec: vi.fn(actual.createProviderSpawnSpec) }
})

function fakeSpawn() {
  const child = createFakePipedChild()
  const specs: ProcessSpec[] = []
  const spawnImpl: PipedProcessSpawner = (spec) => {
    specs.push(spec)
    return child
  }
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
      expect(spec.args?.slice(2)).toEqual([
        '--',
        '/usr/local/bin/claude',
        '--output-format',
        'stream-json'
      ])
      expect(spec.detached).toBe(true)
      expect(spec.cwd).toBe('/work/repo')
      const supervisorSpec = JSON.parse(
        Buffer.from(String(spec.env?.ORCA_PROVIDER_SUPERVISOR_SPEC), 'base64').toString()
      )
      // A gone Orca closes Claude as its own close does (stdin end and SIGTERM), not with the
      // root-only stdin-end drain a managed provider gets by default.
      expect(vi.mocked(createProviderSpawnSpec)).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        platform,
        { closeRequest: 'stdin-end-and-sigterm' }
      )
      expect(supervisorSpec).toMatchObject({
        closeRequest: 'stdin-end-and-sigterm',
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
        '../provider-process/provider-process-supervisor'
      )
      vi.mocked(createProviderSpawnSpec).mockImplementationOnce((...args) => ({
        ...actual.createProviderSpawnSpec(...args),
        supervised: specSupervised
      }))
      const process = fakeSpawn()
      const spawn = createClaudeCodeProcessSpawn(process.spawnImpl, platform)
      spawn.spawn(sdkOptions())
      expect(spawn.supervised).toBe(specSupervised)

      const managed = spawn.managed
      if (!managed) {
        throw new Error('Claude spawner did not retain its managed child')
      }
      // Claude leaves shortly after stdin ends, before the forced stop.
      process.child.stdin.on('finish', () =>
        setTimeout(() => process.child.emit('exit', 0, null), 10)
      )
      const tree = {
        capture: vi.fn(async () => {}),
        reap: vi.fn(async () => 'exited' as const),
        treeVerdict: 'exited' as const,
        forcedReapAttempted: false
      }
      await expect(proveClaudeChildExitWithReaper({ managed, tree }, () => tree)).resolves.toBe(
        true
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

    expect(spawn.managed?.stderrTail()).toMatch(/claude: not signed in$/)
    expect(spawn.managed?.stderrTail().length).toBe(8192)
  })

  it('preserves a Windows .cmd shim and its arguments for the host spawner', () => {
    const process = fakeSpawn()
    createClaudeCodeProcessSpawn(process.spawnImpl, 'win32').spawn(
      sdkOptions({
        command: 'C:\\Users\\dev\\AppData\\npm\\claude.cmd',
        args: ['--setting-sources=user,project,local', '--session-id', 'a b&c']
      })
    )

    expect(process.specs).toEqual([
      expect.objectContaining({
        program: 'C:\\Users\\dev\\AppData\\npm\\claude.cmd',
        args: ['--setting-sources=user,project,local', '--session-id', 'a b&c']
      })
    ])
  })
})
