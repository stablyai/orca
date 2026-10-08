import type * as DegradedRecovery from '../startup/startup-degraded-recovery'
import { STARTUP_DISCOVERY_READ_TIMEOUT_MS } from '../startup/startup-discovery-read'
// @vitest-environment happy-dom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useDialogRegistry } from '@/store/dialog-registry'
import { resetDialogRegistryForTests } from '@/store/dialog-registry-test-state'
import { APP_OPEN_FEATURE_TIP_TOKEN } from '../components/feature-tips/feature-tip-startup-gate'
import { getDefaultSettings } from '../../../shared/constants'
import type { OnboardingState } from '../../../shared/onboarding-state-types'
import { getDefaultOnboardingState } from '../../../shared/onboarding-defaults'
import { useAppStartupHydration } from './use-app-startup-hydration'
import { useOnboardingAndFeatureTips, type OnboardingGate } from './use-onboarding-and-feature-tips'

const startup = vi.hoisted(() => {
  const fetchSettings = vi.fn(async () => {})
  return {
    fetchSettings,
    recover: vi.fn<typeof DegradedRecovery.recoverFromDegradedStartup>(async () => {}),
    // Stable, as the real selector's: a new identity would restart the chain.
    actions: {
      fetchOrcaProfiles: vi.fn(async () => {}),
      fetchSettings,
      fetchKeybindings: vi.fn(async () => {}),
      hydratePersistedUI: vi.fn(),
      initGitHubCache: vi.fn(async () => {})
    }
  }
})
vi.mock('./use-app-startup-actions', () => ({ useStartupActions: () => startup.actions }))
vi.mock('../startup/startup-degraded-recovery', () => ({
  recoverFromDegradedStartup: startup.recover
}))
vi.mock('../runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: vi.fn(async () => {})
}))
vi.mock('@/components/terminal-pane/codex-detached-pane-restart-scheduler', () => ({
  installCodexDetachedPaneRestartExecutor: () => () => {}
}))
vi.mock('../components/terminal-pane/terminal-appearance', () => ({
  publishTerminalViewAttributesAtAppStart: vi.fn()
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement

const existingUser: OnboardingState = {
  ...getDefaultOnboardingState(),
  closedAt: 1,
  outcome: 'completed'
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Startup as App wires it: the gate, then the chain feeding it. */
function App({ onGate }: { onGate: (gate: OnboardingGate) => void }): null {
  const gate = useOnboardingAndFeatureTips()
  useEffect(() => {
    onGate(gate)
  }, [gate, onGate])
  useAppStartupHydration(gate.applyStartupOnboardingState, gate.applyStartupTipCheckInputs)
  return null
}

let gate: OnboardingGate | null = null
const onboardingRead = { get: vi.fn(async (): Promise<OnboardingState> => existingUser) }

beforeEach(() => {
  gate = null
  resetDialogRegistryForTests()
  startup.fetchSettings.mockReset().mockImplementation(async () => {
    useAppStore.setState({ settings: getDefaultSettings('') })
  })
  startup.recover.mockReset().mockResolvedValue(undefined)
  onboardingRead.get.mockReset().mockResolvedValue(existingUser)
  useAppStore.setState(useAppStore.getInitialState(), true)
  Object.assign(window, {
    api: {
      onboarding: onboardingRead,
      // Startup stops here: everything after this read is out of scope.
      ui: { get: () => new Promise(() => {}), set: vi.fn(async () => undefined) },
      cli: { getInstallStatus: vi.fn(async () => ({ supported: false })) }
    }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function start(): Promise<void> {
  await act(async () => root.render(<App onGate={(next) => (gate = next)} />))
  await flush()
}

function tipCheck(): string {
  return useDialogRegistry.getState().startupSources['feature-tip']
}

it('a failed settings read answers the tip check unavailable, so later dialogs do not wait', async () => {
  // The real fetch swallows the failure and leaves settings unset.
  startup.fetchSettings.mockResolvedValue(undefined)
  await start()
  expect(tipCheck()).toBe('unavailable')
  expect(useDialogRegistry.getState().startupSources['native-chat-resume']).toBe('unavailable')
})

it('a failed onboarding read answers the tip check unavailable', async () => {
  onboardingRead.get.mockRejectedValue(new Error('ipc down'))
  await start()
  expect(tipCheck()).toBe('unavailable')
})

it('startup failing before onboarding is read answers the tip check unavailable', async () => {
  startup.fetchSettings.mockRejectedValue(new Error('boom'))
  await start()
  expect(startup.recover).toHaveBeenCalledTimes(1)
  expect(onboardingRead.get).not.toHaveBeenCalled()
  expect(tipCheck()).toBe('unavailable')
  expect(useDialogRegistry.getState().startupSources['native-chat-resume']).toBe('unavailable')
})

it('the tip check has onboarding as soon as it is read, before startup shows onboarding', async () => {
  await start()
  // Startup has not delivered onboarding to the flow yet (it is parked at ui.get) ...
  expect(gate?.onboarding).toBeNull()
  // ... and the tip check waits only for its own remaining inputs.
  expect(tipCheck()).toBe('pending')
  act(() => useAppStore.setState({ persistedUIReady: true }))
  await flush()
  // The decision owner queues a tip with its answer before its host mounts.
  expect(gate?.appOpenTipId).not.toBeNull()
  expect(tipCheck()).toBe('ready')
  expect(useDialogRegistry.getState().dialogEntries).toEqual([
    expect.objectContaining({ token: APP_OPEN_FEATURE_TIP_TOKEN })
  ])
})

it('onboarding suppression remains terminal after onboarding finishes in the same session', async () => {
  onboardingRead.get.mockResolvedValue(getDefaultOnboardingState())
  await start()
  act(() => useAppStore.setState({ persistedUIReady: true }))
  await flush()
  expect(tipCheck()).toBe('none')
  act(() => gate?.applyStartupOnboardingState(existingUser))
  await flush()
  expect(tipCheck()).toBe('none')
  expect(gate?.appOpenTipId).toBeNull()
})

it('losing a decided tip owner withdraws its candidate before the lazy host has mounted', async () => {
  await start()
  act(() => useAppStore.setState({ persistedUIReady: true }))
  await flush()
  expect(tipCheck()).toBe('ready')
  await act(async () => root.render(null))
  expect(useDialogRegistry.getState().dialogEntries).toEqual([])
})

it('late source failure cannot withdraw a tip that has already been decided', async () => {
  await start()
  act(() => useAppStore.setState({ persistedUIReady: true }))
  await flush()
  const tipId = gate?.appOpenTipId
  act(() => gate?.applyStartupTipCheckInputs(null))
  await flush()
  expect(tipCheck()).toBe('ready')
  expect(gate?.appOpenTipId).toBe(tipId)
  expect(useDialogRegistry.getState().dialogEntries).toEqual([
    expect.objectContaining({ token: APP_OPEN_FEATURE_TIP_TOKEN })
  ])
})

it('with every tip already seen it answers none without waiting for the CLI status', async () => {
  const cliStatus = Promise.withResolvers<never>()
  Object.assign(window.api.cli, { getInstallStatus: () => cliStatus.promise })
  await start()
  act(() =>
    useAppStore.setState({
      persistedUIReady: true,
      featureTipsSeenIds: ['agent-session-search', 'orca-cli', 'cmd-j-palette', 'voice-dictation']
    })
  )
  await flush()
  expect(tipCheck()).toBe('none')
})

it('late onboarding must not open a tip after degraded startup answered unavailable', async () => {
  const onboarding = Promise.withResolvers<OnboardingState>()
  onboardingRead.get.mockReturnValue(onboarding.promise)
  Object.assign(window.api.ui, {
    get: vi.fn(async () => {
      throw new Error('ui read unavailable')
    })
  })
  const realRecovery = await vi.importActual<typeof DegradedRecovery>(
    '../startup/startup-degraded-recovery'
  )
  startup.actions.hydratePersistedUI.mockImplementation((ui, source) => {
    useAppStore.getState().hydratePersistedUI(ui, source)
  })
  startup.recover.mockImplementation(realRecovery.recoverFromDegradedStartup)
  Object.assign(window.api, {
    app: {
      awaitFirstWindowStartupServices: vi.fn(async () => {}),
      recoverLegacyWorkerTerminalsForRendererStartup: vi.fn(async () => {})
    }
  })
  const silent = vi.spyOn(console, 'error').mockImplementation(() => {})
  await start()
  expect(startup.recover).toHaveBeenCalledTimes(1)
  expect(tipCheck()).toBe('unavailable')
  expect(gate?.appOpenTipId).toBeNull()
  await act(async () => onboarding.resolve(existingUser))
  await flush()
  expect(tipCheck()).toBe('unavailable')
  silent.mockRestore()
  expect(gate?.appOpenTipId).toBeNull()
})

it.each(['settings', 'onboarding', 'ui', 'cli'] as const)(
  'a never-answering %s read ends the tip discovery instead of holding later dialogs forever',
  async (source) => {
    vi.useFakeTimers()
    try {
      if (source === 'settings') {
        startup.fetchSettings.mockReturnValue(new Promise(() => {}))
      }
      if (source === 'onboarding') {
        onboardingRead.get.mockReturnValue(new Promise(() => {}))
      }
      if (source === 'cli') {
        window.api.cli.getInstallStatus = () => new Promise(() => {})
        useAppStore.setState({
          persistedUIReady: true,
          featureTipsSeenIds: ['agent-session-search']
        })
      }
      await act(async () => root.render(<App onGate={(next) => (gate = next)} />))
      expect(tipCheck()).toBe('pending')
      await act(async () => vi.advanceTimersByTimeAsync(STARTUP_DISCOVERY_READ_TIMEOUT_MS))
      expect(tipCheck()).toBe('unavailable')
      expect(gate?.appOpenTipId).toBeNull()
      if (source === 'settings') {
        expect(useDialogRegistry.getState().startupSources['native-chat-resume']).toBe(
          'unavailable'
        )
      }
    } finally {
      vi.useRealTimers()
    }
  }
)

it('losing the discovery owner answers unavailable', async () => {
  await start()
  expect(tipCheck()).toBe('pending')
  await act(async () => root.render(null))
  expect(tipCheck()).toBe('unavailable')
})
