import type * as GuestSpawnOptions from './wsl-guest-spawn-options'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareWslGuestTerminalSpawn } from './wsl-guest-terminal-preparation'
import { prepareWslGuestSpawnOptions } from './wsl-guest-spawn-options'
import { buildPtyHostEnv } from '../ipc/pty/host-env/assembly'
import { wslHookRelayManager } from '../agent-hooks/wsl-hook-relay-manager'
import { toAppWslPtyId } from '../../shared/wsl-pty-id'

vi.mock('./wsl-guest-spawn-options', async (importOriginal) => ({
  ...(await importOriginal<typeof GuestSpawnOptions>()),
  prepareWslGuestSpawnOptions: vi.fn()
}))
vi.mock('../ipc/pty/host-env/assembly', () => ({ buildPtyHostEnv: vi.fn() }))
vi.mock('../agent-hooks/wsl-hook-relay-manager', () => ({
  wslHookRelayManager: { ensureForDistro: vi.fn(), getGuestEndpointFilePath: vi.fn() }
}))
const prepared = {
  owner: { distro: 'Ubuntu', relayBuildId: 'build' },
  endpoint: {
    distro: 'Ubuntu',
    userName: 'alice',
    runtime: '/bun',
    entry: '/relay',
    socket: '/socket',
    credentialFile: '/credential'
  },
  home: '/home/alice',
  path: '/usr/bin',
  envBinary: '/usr/bin/env',
  ripgrepPath: '/rg'
}
const options = {
  cols: 80,
  rows: 24,
  sessionId: 'fresh-desktop',
  isNewSession: true,
  env: { ORCA_PANE_KEY: 'pane' }
}
const policy = {
  isPackaged: true,
  userDataPath: 'C:\\Orca',
  selectedCodexHomePath: '/home/alice/.codex',
  agentStatusHooksEnabled: true
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(wslHookRelayManager.ensureForDistro).mockResolvedValue()
  vi.mocked(wslHookRelayManager.getGuestEndpointFilePath).mockReturnValue(
    '/home/alice/.orca-wsl/agent-hooks/instance-a/endpoint'
  )
  vi.mocked(buildPtyHostEnv).mockImplementation((_id, env) => ({
    ...env,
    ORCA_WSL_CLI_DIR: 'C:\\cli'
  }))
  vi.mocked(prepareWslGuestSpawnOptions).mockImplementation(async (_owner, value) => value)
})
describe('guest terminal environment preparation', () => {
  it('awaits the exact owner and reuses host policy before guest translation', async () => {
    const result = await prepareWslGuestTerminalSpawn(prepared, options, {
      ...policy,
      launchAgent: 'omp'
    })
    expect(wslHookRelayManager.ensureForDistro).toHaveBeenCalledWith(
      'Ubuntu',
      policy.selectedCodexHomePath,
      'omp',
      'alice'
    )
    expect(buildPtyHostEnv).toHaveBeenCalledOnce()
    expect(buildPtyHostEnv).toHaveBeenCalledWith(
      'fresh-desktop',
      options.env,
      expect.objectContaining({ isWsl: true, wslDistro: 'Ubuntu', wslUser: 'alice' })
    )
    expect(result.env).toMatchObject({ ORCA_PANE_KEY: 'pane', ORCA_WSL_CLI_DIR: 'C:\\cli' })
  })
  it('refuses foreign-home hook endpoints before building spawn state', async () => {
    for (const endpoint of ['/home/bob/.orca-wsl/agent-hooks/instance-a/endpoint']) {
      vi.mocked(wslHookRelayManager.getGuestEndpointFilePath).mockReturnValue(endpoint)
      await expect(prepareWslGuestTerminalSpawn(prepared, options, policy)).rejects.toThrow(
        'terminal owner'
      )
    }
    expect(buildPtyHostEnv).not.toHaveBeenCalled()
    expect(prepareWslGuestSpawnOptions).not.toHaveBeenCalled()
  })
  it('does not reconfigure an attach or adopt a legacy Windows owner', async () => {
    const sessionId = toAppWslPtyId(prepared.owner, 'pty2:owner:1')
    await prepareWslGuestTerminalSpawn(
      prepared,
      { ...options, sessionId, isNewSession: false },
      policy
    )
    await expect(
      prepareWslGuestTerminalSpawn(
        prepared,
        { ...options, sessionId: 'pty2:windows:1', isNewSession: false },
        policy
      )
    ).rejects.toThrow('WSL-owned')
    expect(wslHookRelayManager.ensureForDistro).not.toHaveBeenCalled()
    expect(buildPtyHostEnv).not.toHaveBeenCalled()
  })
  it('cancels a waiting spawn without aborting the shared hook relay setup', async () => {
    let finish: (() => void) | undefined
    vi.mocked(wslHookRelayManager.ensureForDistro).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const controller = new AbortController()
    const pending = prepareWslGuestTerminalSpawn(prepared, options, policy, controller.signal)
    controller.abort(new Error('spawn cancelled'))
    await expect(pending).rejects.toThrow('spawn cancelled')
    finish?.()
    expect(buildPtyHostEnv).not.toHaveBeenCalled()
  })
  it('refuses a Windows account home before launching a guest hook relay', async () => {
    await expect(
      prepareWslGuestTerminalSpawn(prepared, options, {
        ...policy,
        selectedCodexHomePath: 'C:\\Users\\alice'
      })
    ).rejects.toThrow('account home')
    expect(wslHookRelayManager.ensureForDistro).not.toHaveBeenCalled()
  })
  it('honors disabled hooks without requiring a receiver', async () => {
    await prepareWslGuestTerminalSpawn(prepared, options, {
      ...policy,
      agentStatusHooksEnabled: false
    })
    expect(wslHookRelayManager.ensureForDistro).not.toHaveBeenCalled()
    expect(buildPtyHostEnv).toHaveBeenCalledOnce()
  })
})

it.each([true, false])(
  'prepares daemon hooks for its captured user, enabled=%s',
  async (enabled) => {
    const daemon = {
      owner: prepared.owner,
      endpoint: {
        distro: 'Ubuntu',
        distributionId: 'registration',
        userName: 'alice',
        userId: '1000',
        home: '/home/alice',
        runtime: '/bun',
        entry: '/daemon',
        envBinary: '/usr/bin/env',
        socket: '/socket',
        tokenPath: '/token',
        serverBuildId: 'daemon-build'
      }
    }
    const result = await prepareWslGuestTerminalSpawn(daemon, options, {
      ...policy,
      agentStatusHooksEnabled: enabled
    })
    expect(result).toMatchObject({ sessionId: 'fresh-desktop', isNewSession: true })
    if (enabled) {
      expect(wslHookRelayManager.ensureForDistro).toHaveBeenCalledWith(
        'Ubuntu',
        policy.selectedCodexHomePath,
        undefined,
        'alice'
      )
    } else {
      expect(wslHookRelayManager.ensureForDistro).not.toHaveBeenCalled()
    }
    expect(prepareWslGuestSpawnOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        home: '/home/alice',
        envBinary: '/usr/bin/env',
        endpoint: daemon.endpoint
      }),
      expect.anything(),
      undefined,
      undefined
    )
  }
)

it('keeps the daemon owner captured while hook readiness awaits', async () => {
  const daemon = {
    owner: { ...prepared.owner },
    endpoint: {
      distro: 'Ubuntu',
      userName: 'alice',
      userId: '1000',
      home: '/home/alice',
      runtime: '/bun',
      envBinary: '/usr/bin/env',
      tokenPath: '/token'
    }
  }
  vi.mocked(wslHookRelayManager.ensureForDistro).mockImplementation(async () => {
    daemon.endpoint.userName = 'bob'
    daemon.endpoint.home = '/home/bob'
    daemon.owner.relayBuildId = 'other-owner'
    await Promise.resolve()
  })
  await prepareWslGuestTerminalSpawn(daemon, options, policy)
  expect(prepareWslGuestSpawnOptions).toHaveBeenCalledWith(
    expect.objectContaining({
      owner: prepared.owner,
      endpoint: expect.objectContaining({ userName: 'alice', home: '/home/alice' })
    }),
    expect.anything(),
    undefined,
    undefined
  )
})

it('derives stale-hook deletion only after the guest hook coordinates are built', async () => {
  vi.mocked(buildPtyHostEnv).mockImplementation((_id, env) => ({
    ...env,
    ORCA_AGENT_HOOK_ENDPOINT: '/home/alice/.orca-wsl/agent-hooks/endpoint'
  }))
  const result = await prepareWslGuestTerminalSpawn(prepared, options, policy)
  expect(result.envToDelete).not.toContain('ORCA_AGENT_HOOK_ENDPOINT')
  expect(result.envToDelete).toContain('ORCA_AGENT_HOOK_PORT')
})

it('degrades missing hook endpoints without blocking fresh terminals', async () => {
  vi.mocked(wslHookRelayManager.getGuestEndpointFilePath).mockReturnValue(null)
  await prepareWslGuestTerminalSpawn(prepared, options, policy)
  expect(buildPtyHostEnv).toHaveBeenCalledWith(
    'fresh-desktop',
    options.env,
    expect.objectContaining({ agentStatusHooksEnabled: false })
  )
  expect(prepareWslGuestSpawnOptions).toHaveBeenCalledOnce()
})

it('degrades failed optional hook setup without using a stale endpoint', async () => {
  vi.mocked(wslHookRelayManager.ensureForDistro).mockRejectedValueOnce(new Error('unavailable'))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await prepareWslGuestTerminalSpawn(prepared, options, policy)
    expect(buildPtyHostEnv).toHaveBeenCalledWith(
      'fresh-desktop',
      options.env,
      expect.objectContaining({ agentStatusHooksEnabled: false })
    )
    expect(wslHookRelayManager.getGuestEndpointFilePath).not.toHaveBeenCalled()
  } finally {
    warn.mockRestore()
  }
})

it('accepts a selected account UNC path using registered distro casing', async () => {
  await prepareWslGuestTerminalSpawn(
    {
      ...prepared,
      owner: { ...prepared.owner, distro: 'ubuntu' },
      endpoint: { ...prepared.endpoint, distro: 'ubuntu' }
    },
    options,
    { ...policy, selectedCodexHomePath: '\\\\wsl$\\Ubuntu\\home\\alice\\.codex' }
  )
  expect(buildPtyHostEnv).toHaveBeenCalledWith(
    'fresh-desktop',
    options.env,
    expect.objectContaining({ selectedCodexHomePath: '/home/alice/.codex', wslDistro: 'ubuntu' })
  )
})

it('prepares a confirmed exited terminal with its raw guest identity and current account', async () => {
  const daemon = {
    owner: prepared.owner,
    endpoint: {
      ...prepared.endpoint,
      userId: '1000',
      home: '/home/alice',
      envBinary: '/usr/bin/env',
      tokenPath: '/token'
    }
  }
  const sessionId = toAppWslPtyId(prepared.owner, 'pty2:owner:1')
  const result = await prepareWslGuestTerminalSpawn(
    daemon,
    { ...options, sessionId, isNewSession: false, command: 'claude --resume current' },
    policy,
    undefined,
    'confirmed-exited'
  )
  expect(result).toMatchObject({
    sessionId,
    isNewSession: false,
    command: 'claude --resume current'
  })
  expect(buildPtyHostEnv).toHaveBeenCalledWith(
    'pty2:owner:1',
    options.env,
    expect.objectContaining({ wslUser: 'alice', selectedCodexHomePath: '/home/alice/.codex' })
  )
  vi.clearAllMocks()
  await expect(
    prepareWslGuestTerminalSpawn(
      daemon,
      {
        ...options,
        sessionId: toAppWslPtyId({ ...prepared.owner, relayBuildId: 'foreign' }, 'pty2:owner:1'),
        isNewSession: false
      },
      policy,
      undefined,
      'confirmed-exited'
    )
  ).rejects.toThrow()
  expect(buildPtyHostEnv).not.toHaveBeenCalled()
})
