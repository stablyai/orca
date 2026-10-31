// @vitest-environment happy-dom

import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState } from '../../../shared/onboarding-defaults'
import type { OnboardingState } from '../../../shared/onboarding-state-types'
import { useAppStore } from '../store'
import { useAppStartupHydration } from './use-app-startup-hydration'
import { useOnboardingAndFeatureTips } from './use-onboarding-and-feature-tips'

const startup = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  fetchOrcaProfiles: vi.fn(),
  hydratePersistedUI: vi.fn(),
  reconnectPersistedTerminals: vi.fn(),
  initGitHubCache: vi.fn()
}))

vi.mock('./use-app-startup-actions', () => ({ useStartupActions: () => startup }))
vi.mock('../store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create((set) => ({
      activeModal: 'none',
      settings: { voice: { enabled: true }, aiVaultSearch: { enabled: true } },
      persistedUIReady: true,
      featureTipsSeenIds: ['cmd-j-palette'],
      featureInteractions: {},
      chatUiLaunchTipVariant: null,
      contextualToursAutoEligible: false,
      terminalStartupRestorationReady: false,
      openModal: vi.fn(),
      markFeatureTipsSeen: vi.fn(),
      setChatUiLaunchTipVariant: (chatUiLaunchTipVariant: string) =>
        set({ chatUiLaunchTipVariant }),
      setContextualToursAutoEligible: vi.fn(),
      setContextualToursOnboardingVisible: vi.fn()
    }))
  }
})
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('../lib/web-client-location', () => ({ isWebClientLocation: () => false }))
vi.mock('../runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: vi.fn()
}))
vi.mock('../lib/structured-agent-session-launch-surface', () => ({
  restoreStructuredLaunchSurfaces: vi.fn()
}))
vi.mock('../runtime/local-structured-chats', () => ({
  restoreLocalStructuredChatsAtStartup: vi.fn()
}))
vi.mock('../components/terminal-pane/codex-detached-pane-restart-scheduler', () => ({
  installCodexDetachedPaneRestartExecutor: () => () => {}
}))
vi.mock('../components/terminal/terminal-provider-snapshot-capability', () => ({
  collectTerminalProviderSnapshotPtyIds: () => [],
  refreshTerminalProviderSnapshotCapabilities: async () => undefined
}))
vi.mock('../components/feature-tips/feature-tip-telemetry', () => ({
  trackChatUiFeatureTipShown: vi.fn(),
  trackCmdJPaletteFeatureTipShown: vi.fn(),
  trackOrcaCliFeatureTipShown: vi.fn()
}))

function Harness() {
  const gate = useOnboardingAndFeatureTips()
  useAppStartupHydration(gate.applyStartupOnboardingState)
  return <span>{String(gate.startupPromptsFinished)}</span>
}

let root: Root
let container: HTMLDivElement
let resolveOnboarding: (state: OnboardingState) => void
const completedOnboarding: OnboardingState = {
  ...getDefaultOnboardingState(),
  closedAt: 1,
  outcome: 'completed',
  lastCompletedStep: 4
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  startup.fetchSettings.mockRejectedValue(new Error('Settings unavailable'))
  startup.reconnectPersistedTerminals.mockResolvedValue(undefined)
  useAppStore.setState({ chatUiLaunchTipVariant: null, terminalStartupRestorationReady: false })
  const onboarding = new Promise<OnboardingState>((resolve) => {
    resolveOnboarding = resolve
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      onboarding: {
        get: () => onboarding,
        getChatUiLaunchTipVariant: async () => 'none'
      },
      cli: { getInstallStatus: async () => ({ supported: false }) },
      app: {
        awaitFirstWindowStartupServices: async () => undefined,
        recoverLegacyWorkerTerminalsForRendererStartup: async () => undefined
      }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('onboarding delivery during degraded startup', () => {
  it('releases the prompt gate when onboarding resolves after recovery', async () => {
    await act(async () =>
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>
      )
    )
    expect(useAppStore.getState().terminalStartupRestorationReady).toBe(true)
    expect(container.textContent).toBe('false')

    await act(async () => resolveOnboarding(completedOnboarding))
    expect(container.textContent).toBe('true')
  })

  it('does not deliver a pending read after unmount', async () => {
    const onLoaded = vi.fn()
    function DeliveryHarness() {
      useAppStartupHydration(onLoaded)
      return null
    }
    await act(async () => root.render(<DeliveryHarness />))
    await act(async () => root.render(null))
    await act(async () => resolveOnboarding(completedOnboarding))
    expect(onLoaded).not.toHaveBeenCalled()
  })
})
