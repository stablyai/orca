import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AgentHookTarget } from '../../shared/agent-hook-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { OnboardingState } from '../../shared/onboarding-state-types'
import type { Store } from '../persistence'
import type * as AgentStatusHooksEnablement from '../agent-hooks/agent-status-hooks-enablement'

const {
  handleMock,
  removeHandlerMock,
  installManagedAgentHooksMock,
  recordManagedHookInstallFailureMock,
  sanitizeOnboardingUpdateMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  installManagedAgentHooksMock: vi.fn(),
  recordManagedHookInstallFailureMock: vi.fn(),
  sanitizeOnboardingUpdateMock: vi.fn((updates: unknown) => updates)
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

vi.mock('../persistence', () => ({
  sanitizeOnboardingUpdate: sanitizeOnboardingUpdateMock
}))

// Only the installer is faked: the registry behind the real module pulls in every per-agent hook
// service, but the off-switch predicates live in a registry-free module, so use the real ones.
vi.mock('../agent-hooks/managed-agent-hook-controls', async () => {
  const enablement = await vi.importActual<typeof AgentStatusHooksEnablement>(
    '../agent-hooks/agent-status-hooks-enablement'
  )
  return {
    installManagedAgentHooks: installManagedAgentHooksMock,
    isAgentStatusHooksEnabled: enablement.isAgentStatusHooksEnabled,
    shouldContinueManagedHookStartup: enablement.shouldContinueManagedHookStartup
  }
})

vi.mock('../agent-hooks/install-telemetry', () => ({
  recordManagedHookInstallFailure: recordManagedHookInstallFailureMock
}))

import { registerOnboardingHandlers } from './onboarding'

type OnboardingUpdate = Partial<OnboardingState>
type OnboardingConsentArg = { agentStatusHooksEnabled?: unknown } | undefined

function createStoreFake(initial: {
  onboarding?: Partial<OnboardingState>
  settings?: Partial<GlobalSettings>
  failSettingsWrite?: boolean
}) {
  let onboarding = {
    flowVersion: 1,
    closedAt: null,
    outcome: null,
    lastCompletedStep: -1,
    ...initial.onboarding
  } as OnboardingState
  let settings = {
    disabledTuiAgents: [],
    managedAgentHookFirstRunGate: 'pending',
    ...initial.settings
  } as GlobalSettings
  return {
    getOnboarding: vi.fn(() => onboarding),
    getSettings: vi.fn(() => settings),
    updateOnboarding: vi.fn((updates: OnboardingUpdate) => {
      onboarding = { ...onboarding, ...updates }
      return onboarding
    }),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      if (initial.failSettingsWrite && 'agentStatusHooksEnabled' in updates) {
        throw new Error('settings disk write failed')
      }
      settings = { ...settings, ...updates }
      return settings
    })
  }
}

function registerAndGetUpdateHandler(
  store: ReturnType<typeof createStoreFake>,
  deps: { isQuitting?: () => boolean } = {}
) {
  registerOnboardingHandlers(store as unknown as Store, deps)
  const entry = handleMock.mock.calls.find(([channel]) => channel === 'onboarding:update')
  if (!entry) {
    throw new Error('onboarding:update handler was not registered')
  }
  return (updates: OnboardingUpdate, consent?: OnboardingConsentArg): OnboardingState =>
    (entry[1] as (event: unknown, updates: unknown, consent: unknown) => OnboardingState)(
      {},
      updates,
      consent
    )
}

function lastShouldContinue(): (agent: AgentHookTarget) => boolean {
  const options = installManagedAgentHooksMock.mock.calls.at(-1)?.[1] as {
    shouldContinue?: (agent: AgentHookTarget) => boolean
  }
  if (!options?.shouldContinue) {
    throw new Error('install was not given a shouldContinue callback')
  }
  return options.shouldContinue
}

describe('onboarding:update first-run managed hook install', () => {
  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    installManagedAgentHooksMock.mockReset().mockResolvedValue([])
    recordManagedHookInstallFailureMock.mockReset()
  })

  it('installs once when passing step 1 lifts the deferral, and retires the latch', () => {
    const store = createStoreFake({})
    const update = registerAndGetUpdateHandler(store)

    update({ lastCompletedStep: 1 })

    expect(installManagedAgentHooksMock).toHaveBeenCalledTimes(1)
    expect(store.getSettings().managedAgentHookFirstRunGate).toBe('done')
  })

  it('never marks the first-run install user-initiated', () => {
    // Why: grok treats an existing empty hooks.json as a deliberate opt-out unless userInitiated
    // is set, and the startup install this replaces passes none.
    const store = createStoreFake({})
    const update = registerAndGetUpdateHandler(store)

    update({ lastCompletedStep: 1 })

    expect(installManagedAgentHooksMock.mock.calls[0][1]).not.toHaveProperty('userInitiated', true)
  })

  it('installs nothing when the user unchecked the box, but still retires the latch', () => {
    const store = createStoreFake({ settings: { agentStatusHooksEnabled: false } })
    const update = registerAndGetUpdateHandler(store)

    update({ lastCompletedStep: 1 })

    expect(installManagedAgentHooksMock).not.toHaveBeenCalled()
    expect(store.getSettings().managedAgentHookFirstRunGate).toBe('done')
  })

  it('retires the latch and installs when the wizard is dismissed instead of advanced', () => {
    const store = createStoreFake({})
    const update = registerAndGetUpdateHandler(store)

    update({ closedAt: 1_700_000_000_000, outcome: 'dismissed' })

    expect(installManagedAgentHooksMock).toHaveBeenCalledTimes(1)
    expect(store.getSettings().managedAgentHookFirstRunGate).toBe('done')
  })

  it('stays deferred while the user is still before step 1', () => {
    const store = createStoreFake({})
    const update = registerAndGetUpdateHandler(store)

    update({ lastCompletedStep: 0 })

    expect(installManagedAgentHooksMock).not.toHaveBeenCalled()
    expect(store.getSettings().managedAgentHookFirstRunGate).toBe('pending')
  })

  it('does not install again on a later update in the same run', () => {
    const store = createStoreFake({})
    const update = registerAndGetUpdateHandler(store)

    update({ lastCompletedStep: 1 })
    update({ lastCompletedStep: 2 })

    expect(installManagedAgentHooksMock).toHaveBeenCalledTimes(1)
  })

  it('does not install again after the user re-opens the wizard from Help', () => {
    const store = createStoreFake({})
    const update = registerAndGetUpdateHandler(store)

    update({ lastCompletedStep: 1 })
    // showOnboardingFromRenderer rewinds onboarding state; the retired latch must keep it inert.
    update({ closedAt: null, outcome: null, lastCompletedStep: -1 })
    update({ lastCompletedStep: 1 })

    expect(installManagedAgentHooksMock).toHaveBeenCalledTimes(1)
  })

  it('leaves a pre-release profile with no latch completely alone', () => {
    const store = createStoreFake({ settings: { managedAgentHookFirstRunGate: undefined } })
    const update = registerAndGetUpdateHandler(store)

    update({ lastCompletedStep: 1 })

    expect(installManagedAgentHooksMock).not.toHaveBeenCalled()
    expect(store.updateSettings).not.toHaveBeenCalled()
  })
})

describe('onboarding:update step-1 consent transaction', () => {
  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    installManagedAgentHooksMock.mockReset().mockResolvedValue([])
    recordManagedHookInstallFailureMock.mockReset()
  })

  it('honours a declining consent even when the stored preference is still default-on', () => {
    // Why: the renderer's on-change write reports no failure, so the stored value can be stale.
    const store = createStoreFake({})
    const update = registerAndGetUpdateHandler(store)

    update({ lastCompletedStep: 1 }, { agentStatusHooksEnabled: false })

    expect(installManagedAgentHooksMock).not.toHaveBeenCalled()
    expect(store.getSettings().agentStatusHooksEnabled).toBe(false)
    expect(store.getSettings().managedAgentHookFirstRunGate).toBe('done')
  })

  it('re-enables from the consent when the stored preference says off', () => {
    const store = createStoreFake({ settings: { agentStatusHooksEnabled: false } })
    const update = registerAndGetUpdateHandler(store)

    update({ lastCompletedStep: 1 }, { agentStatusHooksEnabled: true })

    expect(store.getSettings().agentStatusHooksEnabled).toBe(true)
    expect(installManagedAgentHooksMock).toHaveBeenCalledTimes(1)
  })

  it('installs nothing and advances nothing when the preference write fails', () => {
    const store = createStoreFake({ failSettingsWrite: true })
    const update = registerAndGetUpdateHandler(store)

    expect(() => update({ lastCompletedStep: 1 }, { agentStatusHooksEnabled: true })).toThrow(
      'settings disk write failed'
    )

    expect(store.updateOnboarding).not.toHaveBeenCalled()
    expect(store.getOnboarding().lastCompletedStep).toBe(-1)
    expect(store.getSettings().managedAgentHookFirstRunGate).toBe('pending')
    expect(installManagedAgentHooksMock).not.toHaveBeenCalled()
  })

  it('ignores a non-boolean consent and falls back to the stored preference', () => {
    const store = createStoreFake({ settings: { agentStatusHooksEnabled: false } })
    const update = registerAndGetUpdateHandler(store)

    update({ lastCompletedStep: 1 }, { agentStatusHooksEnabled: 'yes' })

    expect(store.getSettings().agentStatusHooksEnabled).toBe(false)
    expect(installManagedAgentHooksMock).not.toHaveBeenCalled()
  })

  it('never writes the preference for a profile that was not deferring', () => {
    const store = createStoreFake({ settings: { managedAgentHookFirstRunGate: 'done' } })
    const update = registerAndGetUpdateHandler(store)

    update({ lastCompletedStep: 1 }, { agentStatusHooksEnabled: false })

    expect(store.updateSettings).not.toHaveBeenCalled()
    expect(store.getSettings().agentStatusHooksEnabled).toBeUndefined()
  })

  it('carries the consent through the close path that also lifts the deferral', () => {
    const store = createStoreFake({})
    const update = registerAndGetUpdateHandler(store)

    update(
      { closedAt: 1_700_000_000_000, outcome: 'dismissed' },
      { agentStatusHooksEnabled: false }
    )

    expect(store.getSettings().agentStatusHooksEnabled).toBe(false)
    expect(installManagedAgentHooksMock).not.toHaveBeenCalled()
  })
})

describe('onboarding:update install cancellation', () => {
  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    installManagedAgentHooksMock.mockReset().mockResolvedValue([])
    recordManagedHookInstallFailureMock.mockReset()
  })

  it('stops the in-flight install once the user turns hooks off in Settings', () => {
    const store = createStoreFake({})
    const update = registerAndGetUpdateHandler(store)

    update({ lastCompletedStep: 1 })
    const shouldContinue = lastShouldContinue()
    expect(shouldContinue('claude')).toBe(true)

    store.updateSettings({ agentStatusHooksEnabled: false })

    expect(shouldContinue('claude')).toBe(false)
  })

  it('skips agents the user disabled mid-install', () => {
    const store = createStoreFake({})
    const update = registerAndGetUpdateHandler(store)

    update({ lastCompletedStep: 1 })
    const shouldContinue = lastShouldContinue()

    store.updateSettings({ disabledTuiAgents: ['cursor'] })

    expect(shouldContinue('cursor')).toBe(false)
    expect(shouldContinue('claude')).toBe(true)
  })

  it('stops the in-flight install when the app starts quitting', () => {
    const store = createStoreFake({})
    let quitting = false
    const update = registerAndGetUpdateHandler(store, { isQuitting: () => quitting })

    update({ lastCompletedStep: 1 })
    const shouldContinue = lastShouldContinue()
    expect(shouldContinue('claude')).toBe(true)

    quitting = true

    expect(shouldContinue('claude')).toBe(false)
  })
})
