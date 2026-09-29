import { beforeEach, describe, expect, it, vi } from 'vitest'

// Why the mocks: this file proves only the hooks-off gate in front of the real-home installer;
// the real import graph reaches electron, the codex app-server grant client, and WSL discovery.
// `managed-agent-hook-controls` is deliberately NOT mocked so the gate reads the real predicate.
const { ensureRealHomeCodexHookState, prepareRuntimeHomeForLaunch } = vi.hoisted(() => ({
  ensureRealHomeCodexHookState: vi.fn(() => Promise.resolve('installed')),
  prepareRuntimeHomeForLaunch: vi.fn(() => Promise.resolve({ state: 'installed' }))
}))
vi.mock('electron', () => ({ app: { getPath: () => '/user-data' } }))
vi.mock('../codex/codex-real-home-hook-install', () => ({ ensureRealHomeCodexHookState }))
vi.mock('../codex/hook-service', () => ({ codexHookService: { prepareRuntimeHomeForLaunch } }))
vi.mock('../agent-trust-presets', () => ({ markCodexProjectTrusted: vi.fn() }))
vi.mock('../wsl', () => ({ getDefaultWslDistro: () => 'Ubuntu' }))

import { prepareCodexRuntimeHomeForLaunch } from './codex-launch-preparation'
import { mainProcessState } from './main-process-state'

function setUpSystemDefaultRealHome(agentStatusHooksEnabled: boolean | undefined): void {
  mainProcessState.store = {
    getSettings: () => ({ agentStatusHooksEnabled })
  } as unknown as typeof mainProcessState.store
  mainProcessState.codexRuntimeHome = {
    isHostSystemDefaultRealHomeSelected: () => true,
    // Why null: "system default", i.e. the pane runs on the user's real ~/.codex.
    prepareForCodexLaunchAsync: () => Promise.resolve(null)
  } as unknown as typeof mainProcessState.codexRuntimeHome
}

beforeEach(() => {
  ensureRealHomeCodexHookState.mockClear()
  prepareRuntimeHomeForLaunch.mockClear()
})

describe('prepareCodexRuntimeHomeForLaunch real-home hooks', () => {
  it('never touches the user-global ~/.codex when this profile has status hooks off', async () => {
    setUpSystemDefaultRealHome(false)

    await expect(prepareCodexRuntimeHomeForLaunch()).resolves.toBeNull()

    expect(ensureRealHomeCodexHookState).not.toHaveBeenCalled()
  })

  it('installs into the real home when status hooks are on', async () => {
    setUpSystemDefaultRealHome(true)

    await expect(prepareCodexRuntimeHomeForLaunch()).resolves.toBeNull()

    expect(ensureRealHomeCodexHookState).toHaveBeenCalledTimes(1)
    expect(ensureRealHomeCodexHookState).toHaveBeenCalledWith({
      hooksEnabled: true,
      userDataPath: '/user-data'
    })
  })

  it('installs into the real home when the preference is unset', async () => {
    setUpSystemDefaultRealHome(undefined)

    await prepareCodexRuntimeHomeForLaunch()

    expect(ensureRealHomeCodexHookState).toHaveBeenCalledWith({
      hooksEnabled: true,
      userDataPath: '/user-data'
    })
  })
})
