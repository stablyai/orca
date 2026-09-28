import { runInNewContext } from 'node:vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareWslGuestSpawnOptions as prepareOptions } from './wsl-guest-spawn-options'
import { runWslProcess } from './wsl-runner'
import { assertWslRuntimeDistroRunning, createRunningWslRuntimeRunner } from './wsl-bun-runtime'
import { toAppWslPtyId } from '../../shared/wsl-pty-id'
import type { PtySpawnOptions } from '../providers/types'
function prepareWslGuestSpawnOptions(
  prepared: Parameters<typeof prepareOptions>[0],
  options: Partial<PtySpawnOptions>
) {
  return prepareOptions(prepared, { cols: 80, rows: 24, ...options })
}

vi.mock('./wsl-runner', () => ({ runWslProcess: vi.fn() }))
vi.mock('./wsl-bun-runtime', () => ({
  assertWslRuntimeDistroRunning: vi.fn(),
  createRunningWslRuntimeRunner: vi.fn()
}))
vi.mock('../pty/wsl-orca-env', () => ({ addOrcaWslInteropEnv: vi.fn() }))
const prepared = {
  endpoint: {
    distro: 'Ubuntu',
    userName: 'user',
    userId: '1000',
    runtime: '/runtime/bun',
    entry: '/relay/relay.js',
    socket: '/socket',
    credentialFile: '/credential'
  },
  owner: { distro: 'Ubuntu', relayBuildId: 'build+hash' },
  home: '/home/user',
  path: '/usr/bin',
  envBinary: '/usr/bin/env',
  ripgrepPath: '/relay/rg'
}
const run = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(createRunningWslRuntimeRunner).mockReturnValue({
    run,
    signal: new AbortController().signal
  })
  run.mockResolvedValue('/mnt/c/work')
  vi.mocked(runWslProcess).mockResolvedValue({
    code: 0,
    stdout: JSON.stringify({
      PATH: '/usr/bin',
      HOME: '/home/user',
      SHELL: '/bin/bash',
      ORCA_TOKEN: 'token'
    }),
    stderr: '',
    timedOut: false,
    environmentResolved: true
  })
})

describe('guest terminal spawn preparation', () => {
  it('fences existing identities without probing or spawning', async () => {
    const sessionId = toAppWslPtyId(prepared.owner, 'pty2:owner:1')
    expect(await prepareWslGuestSpawnOptions(prepared, { sessionId })).toEqual({
      cols: 80,
      rows: 24,
      sessionId,
      isNewSession: false
    })
    await expect(
      prepareWslGuestSpawnOptions(prepared, { sessionId: 'pty2:windows:1' })
    ).rejects.toThrow('WSL-owned')
    await expect(
      prepareWslGuestSpawnOptions(prepared, {
        sessionId: toAppWslPtyId({ ...prepared.owner, distro: 'Debian' }, 'pty2:owner:1')
      })
    ).rejects.toThrow('different distro')
    expect(runWslProcess).not.toHaveBeenCalled()
  })
  it('translates host cwd and replaces inherited host shell environment', async () => {
    const result = await prepareWslGuestSpawnOptions(prepared, {
      sessionId: 'desktop-new',
      isNewSession: true,
      cwd: 'C:\\work',
      env: {
        PATH: 'C:\\Windows',
        HOME: 'C:\\Users\\user',
        NODE_OPTIONS: '--require bad',
        ORCA_TOKEN: 'token'
      },
      shellOverride: 'wsl.exe'
    })
    expect(result).toMatchObject({
      cwd: '/mnt/c/work',
      env: { PATH: '/usr/bin', HOME: '/home/user', ORCA_TOKEN: 'token' }
    })
    expect(result.sessionId).toBeUndefined()
    expect(result.shellOverride).toBeUndefined()
    expect(run).toHaveBeenCalledWith({
      program: 'wslpath',
      args: ['-a', '-u', 'C:\\work'],
      loginPath: 'none'
    })
    const spec = vi.mocked(runWslProcess).mock.calls[0][0]
    expect(spec.env).not.toHaveProperty('PATH')
    expect(spec.env).not.toHaveProperty('NODE_OPTIONS')
    expect(spec.args).toEqual(
      expect.arrayContaining(['--no-env-file', '--config=/dev/null', '--no-install'])
    )
    expect(spec.args).toContain('-u')
    expect(assertWslRuntimeDistroRunning).toHaveBeenCalled()
  })
  it('rejects foreign UNC cwd, reminted guest IDs and fresh attach-only requests', async () => {
    await expect(
      prepareWslGuestSpawnOptions(prepared, { cwd: '\\\\wsl.localhost\\Debian\\home' })
    ).rejects.toThrow('different WSL distro')
    await expect(
      prepareWslGuestSpawnOptions(prepared, {
        sessionId: toAppWslPtyId(prepared.owner, 'pty2:owner:1'),
        isNewSession: true
      })
    ).rejects.toThrow('reminted')
    await expect(prepareWslGuestSpawnOptions(prepared, { attachOnly: true })).rejects.toThrow(
      'cannot create'
    )
  })
  it('applies deletions and refuses unavailable guest environment', async () => {
    expect(
      (await prepareWslGuestSpawnOptions(prepared, { envToDelete: ['ORCA_TOKEN'] })).env
    ).not.toHaveProperty('ORCA_TOKEN')
    vi.mocked(runWslProcess).mockResolvedValue({
      code: 0,
      stdout: '{}',
      stderr: '',
      timedOut: false,
      environmentResolved: false
    })
    await expect(prepareWslGuestSpawnOptions(prepared, {})).rejects.toThrow('could not be resolved')
  })
})

it('refuses a changed login HOME before returning prepared options', async () => {
  vi.mocked(runWslProcess).mockResolvedValue({
    code: 0,
    stdout: JSON.stringify({ HOME: '/home/other' }),
    stderr: '',
    timedOut: false,
    environmentResolved: true
  })
  await expect(prepareWslGuestSpawnOptions(prepared, {})).rejects.toThrow('captured owner')
})

it('checks guest UID and HOME before the environment probe emits credentials', async () => {
  await prepareWslGuestSpawnOptions(prepared, {})
  const args = vi.mocked(runWslProcess).mock.calls[0][0].args ?? []
  const scriptIndex = args.indexOf('-e') + 1
  const log = vi.fn()
  for (const [uid, home] of [
    [1001, prepared.home],
    [1000, '/home/other']
  ] as const) {
    expect(() =>
      runInNewContext(args[scriptIndex], {
        process: {
          argv: ['bun', ...args.slice(scriptIndex + 1)],
          getuid: () => uid,
          env: { HOME: home, ORCA_TOKEN: 'private' }
        },
        console: { log }
      })
    ).toThrow('execution owner changed')
  }
  expect(log).not.toHaveBeenCalled()
  runInNewContext(args[scriptIndex], {
    process: {
      argv: ['bun', ...args.slice(scriptIndex + 1)],
      getuid: () => 1000,
      env: { HOME: prepared.home }
    },
    console: { log }
  })
  expect(log).toHaveBeenCalledOnce()
})

const daemon = {
  owner: prepared.owner,
  endpoint: {
    distro: 'Ubuntu',
    distributionId: 'registration',
    userName: 'user',
    userId: '1000',
    home: '/home/user',
    runtime: '/runtime/bun',
    entry: '/daemon/daemon.js',
    envBinary: '/usr/bin/env',
    socket: '/socket',
    tokenPath: '/token',
    serverBuildId: 'daemon-build'
  }
}

it('preserves a fresh stable daemon identity while legacy relay spawn still mints its own', async () => {
  const options = {
    sessionId: 'fresh-desktop',
    isNewSession: true,
    cwd: '/work',
    env: { ORCA_PANE_KEY: 'pane' }
  }
  const guest = await prepareWslGuestSpawnOptions(daemon, options)
  expect(guest.sessionId).toBe('fresh-desktop')
  expect(guest.isNewSession).toBe(true)
  expect(guest.shellOverride).toBe('/bin/bash')
  expect(vi.mocked(runWslProcess).mock.calls[0][0]).toMatchObject({
    distro: 'Ubuntu',
    user: 'user',
    program: '/usr/bin/env'
  })
  const relay = await prepareWslGuestSpawnOptions(prepared, options)
  expect(relay.sessionId).toBeUndefined()
  expect(relay.isNewSession).toBeUndefined()
})

it('keeps daemon attaches bound to the encoded owner without auth/environment preparation', async () => {
  const id = toAppWslPtyId(daemon.owner, 'stable-session')
  expect(
    await prepareWslGuestSpawnOptions(daemon, {
      sessionId: id,
      isNewSession: false,
      attachOnly: true
    })
  ).toMatchObject({ sessionId: id, isNewSession: false, attachOnly: true })
  await expect(
    prepareWslGuestSpawnOptions(daemon, {
      sessionId: toAppWslPtyId({ ...daemon.owner, relayBuildId: 'other-user' }, 'stable-session'),
      isNewSession: false
    })
  ).rejects.toThrow('different distro or relay build')
  expect(runWslProcess).not.toHaveBeenCalled()
})

it('injects guest-owned history after login environment resolution for a fresh daemon spawn', async () => {
  run.mockResolvedValue('ready')
  const options = await prepareWslGuestSpawnOptions(daemon, {
    cwd: '/work',
    sessionId: 'fresh',
    isNewSession: true,
    worktreeId: 'folder',
    historyIsolationEnabled: true,
    env: { ORCA_USER_DATA_PATH: 'C:\\Orca\\profile' }
  })
  expect(options.env?.HISTFILE).toMatch(
    /^\/home\/user\/.orca-wsl\/[a-f0-9]+\/terminal-history\/[a-f0-9]+\/bash_history$/
  )
  expect(options.env?.ORCA_HISTFILE).toBe(options.env?.HISTFILE)
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ program: '/usr/bin/env', loginPath: 'none' })
  )
  expect(options.sessionId).toBe('fresh')
})

it('accepts UNC paths with registered casing for a canonical fresh owner', async () => {
  const owner = {
    ...prepared,
    owner: { ...prepared.owner, distro: 'ubuntu' },
    endpoint: { ...prepared.endpoint, distro: 'ubuntu' }
  }
  const result = await prepareWslGuestSpawnOptions(owner, {
    cwd: String.raw`\\wsl$\Ubuntu\home\user`,
    env: { CODEX_HOME: String.raw`\\wsl$\Ubuntu\home\user\.codex` }
  })
  expect(result.cwd).toBe('/home/user')
  expect(runWslProcess).toHaveBeenCalledWith(
    expect.objectContaining({
      env: expect.objectContaining({ CODEX_HOME: '/home/user/.codex' })
    })
  )
})

it('translates a positively absent daemon session without reminting its ID or inheriting desktop paths', async () => {
  run.mockResolvedValue('ready')
  const id = toAppWslPtyId(daemon.owner, 'retained')
  const result = await prepareOptions(
    daemon,
    {
      cols: 80,
      rows: 24,
      sessionId: id,
      isNewSession: false,
      cwd: '\\\\wsl$\\Ubuntu\\work',
      worktreeId: 'folder',
      historyIsolationEnabled: true,
      env: { PATH: 'C:\\bin', HOME: 'C:\\Users\\bob', ORCA_USER_DATA_PATH: 'C:\\profile' }
    },
    undefined,
    'confirmed-exited'
  )
  expect(result).toMatchObject({
    sessionId: id,
    isNewSession: false,
    cwd: '/work',
    shellOverride: '/bin/bash',
    env: { HOME: '/home/user', PATH: '/usr/bin' }
  })
  expect(result.env?.HISTFILE).toContain('/home/user/.orca-wsl/')
  expect(runWslProcess).toHaveBeenCalledWith(
    expect.objectContaining({
      user: 'user',
      env: expect.not.objectContaining({ PATH: 'C:\\bin', HOME: 'C:\\Users\\bob' })
    })
  )
})
