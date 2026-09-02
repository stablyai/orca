import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import type { PersistedState } from '../../shared/persisted-state-types'

const {
  applyAgentStatusHooksEnabledMock,
  callMock,
  getCliStatusMock,
  getDefaultUserDataPathMock,
  getManagedAgentHookStatusesMock,
  prepareManagedCodexHomeBeforeShellLaunchMock
} = vi.hoisted(() => ({
  applyAgentStatusHooksEnabledMock: vi.fn(),
  callMock: vi.fn(),
  getCliStatusMock: vi.fn(() =>
    Promise.resolve({
      id: 'test-status',
      ok: true,
      result: {
        app: { running: false, pid: null },
        runtime: { state: 'not_running', reachable: false, runtimeId: null },
        graph: { state: 'not_running' }
      },
      _meta: { runtimeId: 'test' }
    })
  ),
  getDefaultUserDataPathMock: vi.fn(),
  getManagedAgentHookStatusesMock: vi.fn(),
  prepareManagedCodexHomeBeforeShellLaunchMock: vi.fn()
}))

vi.mock('../runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = getCliStatusMock
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    getDefaultUserDataPath: getDefaultUserDataPathMock
  }
})

vi.mock('../../main/agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock,
  getManagedAgentHookStatuses: getManagedAgentHookStatusesMock,
  prepareManagedCodexHomeBeforeShellLaunch: prepareManagedCodexHomeBeforeShellLaunchMock
}))

import { main } from '../index'

function readDataFile(userDataPath: string): PersistedState {
  return JSON.parse(readFileSync(join(userDataPath, 'orca-data.json'), 'utf-8')) as PersistedState
}

function writeDataFile(userDataPath: string, state: PersistedState): void {
  mkdirSync(userDataPath, { recursive: true })
  writeFileSync(join(userDataPath, 'orca-data.json'), JSON.stringify(state, null, 2), 'utf-8')
}

async function runAgentHooksOff(userDataPath: string): Promise<void> {
  getDefaultUserDataPathMock.mockReturnValue(userDataPath)
  await main(['agent', 'hooks', 'off', '--json'], userDataPath)
}

describe('agent hooks CLI handler', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-agent-hooks-cli-'))
    applyAgentStatusHooksEnabledMock.mockReturnValue([])
    callMock.mockReset()
    getCliStatusMock.mockClear()
    getManagedAgentHookStatusesMock.mockReturnValue([])
    prepareManagedCodexHomeBeforeShellLaunchMock.mockReset()
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('keeps new card style off when creating offline settings for a fresh profile', async () => {
    await runAgentHooksOff(userDataPath)

    const persisted = readDataFile(userDataPath)

    expect(persisted.settings.experimentalNewWorktreeCardStyle).toBe(false)
    expect(persisted.settings.agentStatusHooksEnabled).toBe(false)
  })

  it('keeps missing new card style off when updating offline settings', async () => {
    const existing = getDefaultPersistedState(userDataPath)
    delete existing.settings.experimentalNewWorktreeCardStyle
    writeDataFile(userDataPath, existing)

    await runAgentHooksOff(userDataPath)

    expect(readDataFile(userDataPath).settings.experimentalNewWorktreeCardStyle).toBe(false)
  })

  it('preserves an existing explicit new card style opt-in when updating offline settings', async () => {
    const existing = getDefaultPersistedState(userDataPath)
    existing.settings.experimentalNewWorktreeCardStyle = true
    writeDataFile(userDataPath, existing)

    await runAgentHooksOff(userDataPath)

    expect(readDataFile(userDataPath).settings.experimentalNewWorktreeCardStyle).toBe(true)
  })

  it('prepares managed Codex trust with the current hooks setting', async () => {
    const state = getDefaultPersistedState(userDataPath)
    state.settings.agentStatusHooksEnabled = false
    writeDataFile(userDataPath, state)
    getDefaultUserDataPathMock.mockReturnValue(userDataPath)

    await main(['agent', 'hooks', 'prepare-codex'], userDataPath)

    expect(prepareManagedCodexHomeBeforeShellLaunchMock).toHaveBeenCalledWith({
      userDataPath,
      hooksEnabled: false
    })
  })

  it('forwards WSL pane routing to the runtime exactly once without using the host installer', async () => {
    const home = '/home/jin/.local/share/orca/codex-runtime-home/home'
    vi.stubEnv('CODEX_HOME', home)
    vi.stubEnv('ORCA_CODEX_HOME', home)
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu-24.04')
    callMock.mockResolvedValue({ result: { state: 'installed' } })

    await main(['agent', 'hooks', 'prepare-codex'], userDataPath)

    expect(callMock).toHaveBeenCalledExactlyOnceWith(
      'agentHooks.prepareCodexForWslPane',
      { codexHome: home, orcaCodexHome: home, wslDistro: 'Ubuntu-24.04' },
      { timeoutMs: 50_000 }
    )
    expect(prepareManagedCodexHomeBeforeShellLaunchMock).not.toHaveBeenCalled()
  })

  it('fails open when WSL runtime preparation is unavailable', async () => {
    vi.stubEnv('CODEX_HOME', '/home/jin/.local/share/orca/codex-runtime-home/home')
    vi.stubEnv('ORCA_CODEX_HOME', '/home/jin/.local/share/orca/codex-runtime-home/home')
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
    callMock.mockRejectedValue(new Error('method_not_found'))

    await expect(main(['agent', 'hooks', 'prepare-codex'], userDataPath)).resolves.toBeUndefined()
    expect(prepareManagedCodexHomeBeforeShellLaunchMock).not.toHaveBeenCalled()
  })

  it('honors Codex-specific disablement when the runtime is unavailable', async () => {
    const state = getDefaultPersistedState(userDataPath)
    state.settings.disabledTuiAgents = ['codex']
    writeDataFile(userDataPath, state)
    getDefaultUserDataPathMock.mockReturnValue(userDataPath)

    await main(['agent', 'hooks', 'prepare-codex'], userDataPath)

    expect(prepareManagedCodexHomeBeforeShellLaunchMock).toHaveBeenCalledWith({
      userDataPath,
      hooksEnabled: false
    })
  })

  it('uses the active profile settings instead of stale legacy settings', async () => {
    const profileId = 'work-profile'
    const legacy = getDefaultPersistedState(userDataPath)
    legacy.settings.agentStatusHooksEnabled = true
    writeDataFile(userDataPath, legacy)
    const profile = getDefaultPersistedState(userDataPath)
    profile.settings.agentStatusHooksEnabled = false
    writeDataFile(join(userDataPath, 'profiles', profileId), profile)
    writeFileSync(
      join(userDataPath, 'orca-profile-index.json'),
      JSON.stringify({
        activeProfileId: profileId,
        profiles: [{ id: profileId }]
      }),
      'utf-8'
    )
    getDefaultUserDataPathMock.mockReturnValue(userDataPath)

    await main(['agent', 'hooks', 'prepare-codex'], userDataPath)

    expect(prepareManagedCodexHomeBeforeShellLaunchMock).toHaveBeenCalledWith({
      userDataPath,
      hooksEnabled: false
    })
  })

  it('honors live hook and Codex-specific disablement before persistence settles', async () => {
    const state = getDefaultPersistedState(userDataPath)
    state.settings.agentStatusHooksEnabled = true
    writeDataFile(userDataPath, state)
    getDefaultUserDataPathMock.mockReturnValue(userDataPath)
    callMock.mockResolvedValue({
      result: {
        settings: { agentStatusHooksEnabled: true, disabledTuiAgents: ['codex'] }
      }
    })

    await main(['agent', 'hooks', 'prepare-codex'], userDataPath)

    expect(prepareManagedCodexHomeBeforeShellLaunchMock).toHaveBeenCalledWith({
      userDataPath,
      hooksEnabled: false
    })
    expect(callMock).toHaveBeenCalledExactlyOnceWith('settings.get', undefined, {
      timeoutMs: 1_000
    })
  })
})
