import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parsePtyProcessCeiling,
  PTY_PROCESS_CEILING_ENV,
  resolveTerminalScopes,
  type TerminalScopeRuntime
} from './terminal-scopes'
import {
  isTerminalScopeWrapper,
  setTerminalScopesForTest,
  wrapPtySpawnInTerminalScope
} from './terminal-scopes-runtime'
import {
  confirmPtyProcessCeiling,
  describePtyProcessCeiling,
  parsePtyProcessCeilingState
} from '../../shared/pty-process-ceiling-state'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import {
  parseMemorySize,
  TERMINAL_MEMORY_MAX_ENV,
  TERMINAL_MEMORY_SWAP_MAX_ENV
} from './terminal-memory-limits'
import type * as DaemonCgroupScope from './daemon-cgroup-scope'

const managerRuntimeDir = vi.hoisted((): { value?: string } => ({}))
vi.mock('./daemon-cgroup-scope', async (importOriginal) => {
  const original = await importOriginal<typeof DaemonCgroupScope>()
  return {
    ...original,
    // The user manager's runtime dir, independent of the host running the test.
    userManagerEnv: (env: NodeJS.ProcessEnv) => {
      const next = { ...env }
      delete next.XDG_RUNTIME_DIR
      return managerRuntimeDir.value ? { ...next, XDG_RUNTIME_DIR: managerRuntimeDir.value } : next
    }
  }
})

const SLICE_CGROUP =
  '/user.slice/user-1000.slice/user@1000.service/orca_ptys_orca_daemon_1f_2e.slice'
const SCOPE_ON = { on: expect.objectContaining({ slice: 'orca_ptys_orca_daemon_1f_2e.slice' }) }

type Call = { program: string; args: string[] }

/**
 * A fake `systemd-run`: may reject OOMPolicy or memory properties on scopes, enforces `pidsMax`
 * on each one, and with memory delegated shows each requested memory limit page-rounded.
 */
function fakeManager({
  oomPolicy = true,
  pidsMax = 'max',
  sliceStarts = true,
  memoryDelegated = true,
  memoryProperties = true,
  swapAccounting = true
} = {}) {
  const calls: Call[] = []
  const run = vi.fn((program: string, args: string[]) => {
    calls.push({ program, args })
    if (program === 'busctl') {
      return { code: sliceStarts ? 0 : 1, timedOut: false, stdout: '' }
    }
    if (program === '/usr/bin/systemd-run') {
      const property = (name: string) =>
        args.find((arg) => arg.startsWith(`--property=${name}=`))?.split('=')[2]
      const rejected =
        (!oomPolicy && args.includes('--property=OOMPolicy=continue')) ||
        (!memoryProperties && property('MemoryMax') !== undefined)
      const pageRounded = (bytes: string | undefined) =>
        bytes === undefined ? 'max' : String(Number(bytes) - (Number(bytes) % 4096))
      const files = [
        ...(pidsMax === '' ? [] : [`pids.max=${pidsMax}`]),
        ...(memoryDelegated ? [`memory.max=${pageRounded(property('MemoryMax'))}`] : []),
        ...(memoryDelegated && swapAccounting
          ? [`memory.swap.max=${pageRounded(property('MemorySwapMax'))}`]
          : [])
      ]
      return rejected
        ? { code: 1, timedOut: false, stdout: '' }
        : {
            code: 0,
            timedOut: false,
            stdout: `${[`0::${SLICE_CGROUP}/run-r1.scope`, ...files].join('\n')}\n`
          }
    }
    return { code: 0, timedOut: false, stdout: '' }
  })
  return { calls, run }
}

function linuxInput(
  manager: ReturnType<typeof fakeManager>,
  overrides: Partial<Parameters<typeof resolveTerminalScopes>[0]> = {}
): Parameters<typeof resolveTerminalScopes>[0] {
  return {
    env: {},
    platform: 'linux',
    daemonScope: 'orca-daemon-1f-2e.scope',
    unifiedCgroup: () => true,
    findExecutable: (name: string) => `/usr/bin/${name}`,
    run: manager.run,
    ...overrides
  }
}

describe('resolveTerminalScopes', () => {
  it('is on by default in the daemon’s own scope, with the slice bound to that scope', () => {
    const manager = fakeManager()
    const resolved = resolveTerminalScopes(linuxInput(manager))
    expect(resolved.ceiling).toEqual({ state: 'off', reason: 'disabled' })
    expect(resolved.scopes).toEqual({
      on: {
        slice: 'orca_ptys_orca_daemon_1f_2e.slice',
        sliceCgroupPath: `/sys/fs/cgroup${SLICE_CGROUP}`,
        systemdRun: '/usr/bin/systemd-run',
        envBinary: '/usr/bin/env',
        launchId: 'orca_daemon_1f_2e',
        properties: ['OOMPolicy=continue', 'TimeoutStopSec=5s']
      }
    })
    expect(manager.calls[0]).toEqual({
      program: 'busctl',
      args: [
        '--user',
        'call',
        'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1',
        'org.freedesktop.systemd1.Manager',
        'StartTransientUnit',
        'ssa(sv)a(sa(sv))',
        'orca_ptys_orca_daemon_1f_2e.slice',
        'fail',
        '2',
        'BindsTo',
        'as',
        '1',
        'orca-daemon-1f-2e.scope',
        'After',
        'as',
        '1',
        'orca-daemon-1f-2e.scope',
        '0'
      ]
    })
    expect(manager.calls[1]?.args.slice(0, 7)).toEqual([
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--slice=orca_ptys_orca_daemon_1f_2e.slice',
      '--property=OOMPolicy=continue',
      '--property=TimeoutStopSec=5s'
    ])
    expect(manager.calls).toHaveLength(2)
  })

  it('drops only OOMPolicy where scopes reject it', () => {
    const manager = fakeManager({ oomPolicy: false })
    const resolved = resolveTerminalScopes(linuxInput(manager))
    expect(resolved.scopes).toMatchObject({ on: { properties: ['TimeoutStopSec=5s'] } })
    expect(manager.calls.filter((call) => call.program === '/usr/bin/systemd-run')).toHaveLength(2)
  })

  it.each([
    ['no owned daemon scope', { daemonScope: null }, 'no_user_manager'],
    ['cgroup v1 or hybrid', { unifiedCgroup: () => false }, 'no_user_manager'],
    [
      'no env binary',
      { findExecutable: (name: string) => (name === 'env' ? null : `/usr/bin/${name}`) },
      'systemd_run_missing'
    ],
    ['macOS', { platform: 'darwin' as const }, 'unsupported_platform']
  ])('stays off with %s, without touching the user manager', (_label, overrides, reason) => {
    const manager = fakeManager()
    const resolved = resolveTerminalScopes(linuxInput(manager, overrides))
    expect(resolved).toEqual({
      ceiling: { state: 'off', reason: 'disabled' },
      scopes: { off: reason }
    })
    expect(manager.run).not.toHaveBeenCalled()
  })

  it('stays off when the slice cannot start, or removes it when no probe scope starts', () => {
    expect(resolveTerminalScopes(linuxInput(fakeManager({ sliceStarts: false }))).scopes).toEqual({
      off: 'slice_unavailable'
    })
    const run = vi.fn((program: string, _args: string[]) => ({
      code: program === 'busctl' || program === 'systemctl' ? 0 : 1,
      timedOut: false,
      stdout: ''
    }))
    const resolved = resolveTerminalScopes(linuxInput({ ...fakeManager(), run }))
    expect(resolved.scopes).toEqual({ off: 'slice_unavailable' })
    expect(run.mock.calls.at(-1)?.[1]).toEqual([
      '--user',
      '--no-block',
      'stop',
      'orca_ptys_orca_daemon_1f_2e.slice'
    ])
  })

  it('stays off, marking a timeout for the log, when a wedged manager does not answer', () => {
    const run = vi.fn((program: string, _args: string[]) => ({
      code: 1,
      timedOut: program !== 'systemctl',
      stdout: ''
    }))
    expect(resolveTerminalScopes(linuxInput({ ...fakeManager(), run })).scopes).toEqual({
      off: 'slice_unavailable',
      timedOut: true
    })
    run.mockImplementation((program: string) => ({
      code: program === 'busctl' ? 0 : 1,
      timedOut: program !== 'busctl',
      stdout: ''
    }))
    expect(resolveTerminalScopes(linuxInput({ ...fakeManager(), run })).scopes).toEqual({
      off: 'slice_unavailable',
      timedOut: true
    })
  })

  it('puts the process ceiling on each terminal scope once the kernel shows it', () => {
    const env = { [PTY_PROCESS_CEILING_ENV]: '2048' }
    const resolved = resolveTerminalScopes(linuxInput(fakeManager({ pidsMax: '2048' }), { env }))
    expect(resolved.ceiling).toEqual({
      state: 'on',
      limit: 2048,
      mechanism: 'systemd-slice',
      unit: 'orca_ptys_orca_daemon_1f_2e.slice',
      controlGroup: SLICE_CGROUP
    })
    expect(resolved.scopes).toMatchObject({
      on: { properties: ['OOMPolicy=continue', 'TimeoutStopSec=5s', 'TasksMax=2048'] }
    })
  })

  it.each([
    ['accepted but not enforced', 'max'],
    ['without pids delegation', '']
  ])(
    'keeps terminal scopes, reporting only the ceiling off, with TasksMax %s',
    (_label, pidsMax) => {
      const env = { [PTY_PROCESS_CEILING_ENV]: '2048' }
      const resolved = resolveTerminalScopes(linuxInput(fakeManager({ pidsMax }), { env }))
      expect(resolved.ceiling).toEqual({ state: 'off', reason: 'controller_unavailable' })
      expect(resolved.scopes).toMatchObject({
        on: { properties: ['OOMPolicy=continue', 'TimeoutStopSec=5s'] }
      })
    }
  )

  it('reports a ceiling that needs a missing daemon scope as no user manager', () => {
    const env = { [PTY_PROCESS_CEILING_ENV]: '2048' }
    const missing = resolveTerminalScopes(
      linuxInput(fakeManager(), { env, daemonScope: null })
    ).ceiling
    expect(missing).toEqual({ state: 'off', reason: 'no_user_manager' })
  })

  it('refuses ceilings too small to run a shell, without turning terminal scopes off', () => {
    const env = { [PTY_PROCESS_CEILING_ENV]: '10' }
    const resolved = resolveTerminalScopes(linuxInput(fakeManager(), { env }))
    expect(resolved.ceiling).toEqual({ state: 'off', reason: 'invalid_limit' })
    expect(resolved.scopes).toEqual(SCOPE_ON)
    expect(JSON.stringify(resolved.scopes)).not.toContain('TasksMax')
    expect(parsePtyProcessCeiling('0')).toEqual({ kind: 'off' })
  })

  it('uses the per-terminal job limit on Windows only when the native build has it', () => {
    const windows = (
      setWindowsLimit: () => boolean,
      env: NodeJS.ProcessEnv = { [PTY_PROCESS_CEILING_ENV]: '2048' }
    ) =>
      resolveTerminalScopes({
        env,
        platform: 'win32',
        daemonScope: null,
        setWindowsLimit
      }).ceiling
    expect(windows(() => true)).toEqual({
      state: 'on',
      limit: 2048,
      mechanism: 'windows-job',
      unit: null
    })
    expect(windows(() => false)).toEqual({ state: 'off', reason: 'native_unavailable' })
    expect(windows(() => true, {})).toEqual({ state: 'off', reason: 'disabled' })
  })
})

describe('terminal memory limits', () => {
  const GIB = 1024 ** 3
  const probes = (manager: ReturnType<typeof fakeManager>) =>
    manager.calls.filter((call) => call.program === '/usr/bin/systemd-run')

  it('stays off by default, adding no memory property and no report', () => {
    const manager = fakeManager()
    const resolved = resolveTerminalScopes(linuxInput(manager))
    expect(resolved.memory).toBeUndefined()
    expect(JSON.stringify(manager.calls)).not.toContain('Memory')
  })

  it('puts MemoryMax and MemorySwapMax on each terminal scope once the kernel shows them', () => {
    const env = { [TERMINAL_MEMORY_MAX_ENV]: '16G', [TERMINAL_MEMORY_SWAP_MAX_ENV]: '0' }
    const manager = fakeManager()
    const resolved = resolveTerminalScopes(linuxInput(manager, { env }))
    const memory = [`MemoryMax=${16 * GIB}`, 'MemorySwapMax=0']
    expect(resolved.scopes).toMatchObject({
      on: { properties: ['OOMPolicy=continue', 'TimeoutStopSec=5s', ...memory] }
    })
    expect(resolved.memory).toEqual({ applied: memory, refused: [] })
    expect(probes(manager)[0]?.args).toEqual(
      expect.arrayContaining(memory.map((property) => `--property=${property}`))
    )
  })

  it('accepts a limit the kernel rounded down to a page', () => {
    const env = { [TERMINAL_MEMORY_MAX_ENV]: String(GIB + 1000) }
    const resolved = resolveTerminalScopes(linuxInput(fakeManager(), { env }))
    expect(resolved.memory).toEqual({ applied: [`MemoryMax=${GIB + 1000}`], refused: [] })
  })

  it.each([
    ['without memory delegation', { memoryDelegated: false }, ['MemoryMax', 'MemorySwapMax']],
    ['without swap accounting', { swapAccounting: false }, ['MemorySwapMax']]
  ])('keeps terminal scopes but drops limits the kernel does not show, %s', (_l, opts, dropped) => {
    const env = { [TERMINAL_MEMORY_MAX_ENV]: '8G', [TERMINAL_MEMORY_SWAP_MAX_ENV]: '1G' }
    const resolved = resolveTerminalScopes(linuxInput(fakeManager(opts), { env }))
    const properties = 'on' in resolved.scopes ? resolved.scopes.on.properties : []
    for (const name of dropped) {
      expect(properties.some((property) => property.startsWith(`${name}=`))).toBe(false)
      expect(resolved.memory?.refused.some((property) => property.startsWith(`${name}=`))).toBe(
        true
      )
    }
    expect(properties).toContain('OOMPolicy=continue')
  })

  it('falls back to scopes without memory limits where the manager rejects them', () => {
    const env = { [TERMINAL_MEMORY_MAX_ENV]: '8G' }
    const manager = fakeManager({ memoryProperties: false })
    const resolved = resolveTerminalScopes(linuxInput(manager, { env }))
    expect(resolved.scopes).toMatchObject({
      on: { properties: ['OOMPolicy=continue', 'TimeoutStopSec=5s'] }
    })
    expect(resolved.memory).toEqual({ applied: [], refused: [`MemoryMax=${8 * GIB}`] })
    expect(probes(manager)).toHaveLength(3)
  })

  it('stops probing after a timeout instead of trying every tier', () => {
    const env = { [TERMINAL_MEMORY_MAX_ENV]: '8G' }
    const run = vi.fn((program: string, _args: string[]) => ({
      code: program === 'busctl' ? 0 : 1,
      timedOut: program === '/usr/bin/systemd-run',
      stdout: ''
    }))
    const resolved = resolveTerminalScopes(linuxInput({ ...fakeManager(), run }, { env }))
    expect(resolved.scopes).toEqual({ off: 'slice_unavailable', timedOut: true })
    expect(run.mock.calls.filter(([program]) => program === '/usr/bin/systemd-run')).toHaveLength(1)
  })

  it('refuses invalid or too-small limits without probing them', () => {
    const env = { [TERMINAL_MEMORY_MAX_ENV]: '64M', [TERMINAL_MEMORY_SWAP_MAX_ENV]: 'lots' }
    const manager = fakeManager()
    const resolved = resolveTerminalScopes(linuxInput(manager, { env }))
    expect(resolved.memory).toEqual({
      applied: [],
      refused: [TERMINAL_MEMORY_MAX_ENV, TERMINAL_MEMORY_SWAP_MAX_ENV]
    })
    expect(JSON.stringify(manager.calls)).not.toContain('Memory')
    expect(parseMemorySize('2g')).toBe(2 * GIB)
    expect(parseMemorySize('512 M')).toBe(512 * 1024 ** 2)
    expect(parseMemorySize('1.5G')).toBeNull()
  })

  it.each([
    ['macOS', 'darwin' as const],
    ['Windows', 'win32' as const]
  ])('is a reported no-op on %s', (_label, platform) => {
    const env = { [TERMINAL_MEMORY_MAX_ENV]: '8G' }
    const manager = fakeManager()
    const resolved = resolveTerminalScopes(linuxInput(manager, { env, platform }))
    expect(resolved.memory).toEqual({ applied: [], refused: [`MemoryMax=${8 * GIB}`] })
    expect(manager.run).not.toHaveBeenCalled()
  })
})

describe('wrapPtySpawnInTerminalScope', () => {
  const runtime: TerminalScopeRuntime = {
    slice: 'orca_ptys_a.slice',
    sliceCgroupPath: '/sys/fs/cgroup/x/orca_ptys_a.slice',
    systemdRun: '/usr/bin/systemd-run',
    envBinary: '/usr/bin/env',
    launchId: 'a',
    properties: ['OOMPolicy=continue', 'TimeoutStopSec=5s', 'TasksMax=2048']
  }
  afterEach(() => setTerminalScopesForTest(null))

  it('leaves the spawn untouched while off', () => {
    const env = { TERM: 'xterm' }
    expect(wrapPtySpawnInTerminalScope('/bin/bash', ['-l'], env)).toEqual({
      file: '/bin/bash',
      args: ['-l'],
      env
    })
  })

  it('execs each terminal into its own scope and gives the shell its own session bus back', () => {
    setTerminalScopesForTest(runtime)
    const spawn = () =>
      wrapPtySpawnInTerminalScope(
        '/bin/bash',
        ['-l'],
        { TERM: 'xterm', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/dbus-x' },
        () => true
      )
    const wrapped = spawn()
    expect(wrapped.file).toBe('/usr/bin/systemd-run')
    const unit = wrapped.args.find((arg) => arg.startsWith('--unit='))
    expect(wrapped.args).toEqual(
      expect.arrayContaining([
        '--user',
        '--scope',
        '--slice=orca_ptys_a.slice',
        '--property=OOMPolicy=continue',
        '--property=TasksMax=2048'
      ])
    )
    expect(spawn().args).not.toContain(unit)
    const command = wrapped.args.slice(wrapped.args.indexOf('--') + 1)
    expect(command[0]).toBe('/usr/bin/env')
    expect(command).toContain('DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-x')
    expect(command.slice(-2)).toEqual(['/bin/bash', '-l'])
    expect(wrapped.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
  })

  it('restores only the session variables that differ, unsetting ones the shell lacked', () => {
    setTerminalScopesForTest(runtime)
    managerRuntimeDir.value = '/run/user/1000'
    const command = (env: Record<string, string>) => {
      const args = wrapPtySpawnInTerminalScope('/bin/bash', [], env, () => true).args
      return args.slice(args.indexOf('--') + 1)
    }
    expect(command({ TERM: 'x' })).toEqual(['/usr/bin/env', '-u', 'XDG_RUNTIME_DIR', '/bin/bash'])
    expect(command({ TERM: 'x', XDG_RUNTIME_DIR: '/run/user/1000' })).toEqual(['/bin/bash'])
    managerRuntimeDir.value = undefined
  })

  it('stops wrapping for good once the slice is gone, and logs it once', () => {
    const log = vi.fn()
    setTerminalScopesForTest(runtime, log)
    expect(wrapPtySpawnInTerminalScope('/bin/bash', [], { TERM: 'x' }, () => false).file).toBe(
      '/bin/bash'
    )
    expect(wrapPtySpawnInTerminalScope('/bin/bash', [], { TERM: 'x' }, () => true).file).toBe(
      '/bin/bash'
    )
    expect(log).toHaveBeenCalledOnce()
  })

  it('recognizes only the exact wrapper paths it execs, not a user-typed systemd-run', () => {
    setTerminalScopesForTest(runtime)
    expect(isTerminalScopeWrapper('/usr/bin/systemd-run')).toBe(true)
    expect(isTerminalScopeWrapper('/usr/bin/env')).toBe(true)
    expect(isTerminalScopeWrapper('systemd-run')).toBe(false)
    setTerminalScopesForTest(null)
    expect(isTerminalScopeWrapper('/usr/bin/systemd-run')).toBe(false)
  })
})

describe('ceiling report', () => {
  it('reports a slice the user manager dropped as lost, not on', () => {
    const on = {
      state: 'on' as const,
      limit: 2048,
      mechanism: 'systemd-slice' as const,
      unit: 'orca_ptys_a.slice',
      controlGroup: '/u/orca_ptys_a.slice'
    }
    expect(confirmPtyProcessCeiling(on, () => true)).toBe(on)
    expect(confirmPtyProcessCeiling(on, () => false)).toEqual({
      state: 'off',
      reason: 'slice_lost'
    })
    expect(confirmPtyProcessCeiling(null)).toBeNull()
  })

  it('round-trips through the daemon pid record and reads old records as not reported', () => {
    const record = parseDaemonPidFile(
      JSON.stringify({ pid: 7, processCeiling: { state: 'off', reason: 'no_user_manager' } })
    )
    expect(record?.processCeiling).toEqual({ state: 'off', reason: 'no_user_manager' })
    expect(parseDaemonPidFile(JSON.stringify({ pid: 7 }))?.processCeiling).toBeNull()
    expect(parsePtyProcessCeilingState({ state: 'off', reason: 'made-up' })).toBeNull()
    expect(describePtyProcessCeiling(null)).toBe('not reported')
    expect(describePtyProcessCeiling({ state: 'off', reason: 'no_user_manager' })).toBe(
      'off (no user manager)'
    )
  })
})
