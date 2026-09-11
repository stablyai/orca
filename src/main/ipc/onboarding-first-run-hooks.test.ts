import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { OnboardingState } from '../../shared/onboarding-state-types'
import type { Store } from '../persistence'

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

// The registry behind the real module pulls in every per-agent hook service; mirror the one-line
// predicate instead (see isAgentStatusHooksEnabled in managed-agent-hook-controls.ts).
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  installManagedAgentHooks: installManagedAgentHooksMock,
  isAgentStatusHooksEnabled: (settings: Partial<GlobalSettings> | null | undefined) =>
    settings?.agentStatusHooksEnabled !== false
}))

vi.mock('../agent-hooks/install-telemetry', () => ({
  recordManagedHookInstallFailure: recordManagedHookInstallFailureMock
}))

import { registerOnboardingHandlers } from './onboarding'

type OnboardingUpdate = Partial<OnboardingState>

function createStoreFake(initial: {
  onboarding?: Partial<OnboardingState>
  settings?: Partial<GlobalSettings>
}) {
  let onboarding = {
    flowVersion: 1,
    closedAt: null,
    outcome: null,
    lastCompletedStep: -1,
    ...initial.onboarding
  } as OnboardingState
  let settings = {
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
      settings = { ...settings, ...updates }
      return settings
    })
  }
}

function registerAndGetUpdateHandler(store: ReturnType<typeof createStoreFake>) {
  registerOnboardingHandlers(store as unknown as Store)
  const entry = handleMock.mock.calls.find(([channel]) => channel === 'onboarding:update')
  if (!entry) {
    throw new Error('onboarding:update handler was not registered')
  }
  return (updates: OnboardingUpdate): OnboardingState =>
    (entry[1] as (event: unknown, updates: unknown) => OnboardingState)({}, updates)
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
    expect(installManagedAgentHooksMock.mock.calls[0][1]).toMatchObject({ userInitiated: true })
    expect(store.getSettings().managedAgentHookFirstRunGate).toBe('done')
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
