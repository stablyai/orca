// @vitest-environment happy-dom

import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState } from '../../../shared/onboarding-defaults'
import { useAppStore } from '../store'
import { useOnboardingAndFeatureTips } from './use-onboarding-and-feature-tips'

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
      openModal: vi.fn((activeModal: string) => set({ activeModal })),
      markFeatureTipsSeen: vi.fn(),
      setChatUiLaunchTipVariant: (chatUiLaunchTipVariant: string) =>
        set({ chatUiLaunchTipVariant }),
      setContextualToursAutoEligible: vi.fn(),
      setContextualToursOnboardingVisible: vi.fn()
    }))
  }
})

vi.mock('../lib/web-client-location', () => ({ isWebClientLocation: () => false }))
vi.mock('../components/feature-tips/feature-tip-telemetry', () => ({
  trackChatUiFeatureTipShown: vi.fn(),
  trackCmdJPaletteFeatureTipShown: vi.fn(),
  trackOrcaCliFeatureTipShown: vi.fn()
}))

const completedOnboarding = {
  ...getDefaultOnboardingState(),
  closedAt: 1,
  outcome: 'completed' as const,
  lastCompletedStep: 4
}

let root: Root
let container: HTMLDivElement
let gate: ReturnType<typeof useOnboardingAndFeatureTips>

function Harness() {
  gate = useOnboardingAndFeatureTips()
  return <span>{String(gate.startupPromptsFinished)}</span>
}

async function loadOnboarding() {
  await act(async () => gate.applyStartupOnboardingState(completedOnboarding))
}

describe('startup prompt completion', () => {
  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    useAppStore.setState({ activeModal: 'none', chatUiLaunchTipVariant: null })
    vi.mocked(useAppStore.getState().openModal).mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        cli: { getInstallStatus: vi.fn().mockResolvedValue({ supported: false }) },
        onboarding: { getChatUiLaunchTipVariant: vi.fn().mockResolvedValue('none') }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () =>
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>
      )
    )
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('finishes immediately once eligibility is known and no tip is needed', async () => {
    expect(container.textContent).toBe('false')
    await loadOnboarding()
    expect(container.textContent).toBe('true')
    expect(useAppStore.getState().openModal).not.toHaveBeenCalled()
  })

  it('waits for a slow audience response, then for the announcement to close', async () => {
    await act(async () => useAppStore.setState({ chatUiLaunchTipVariant: null }))
    await loadOnboarding()
    expect(container.textContent).toBe('false')

    await act(async () => useAppStore.setState({ chatUiLaunchTipVariant: 'chat-ui-on' }))
    expect(useAppStore.getState().activeModal).toBe('feature-tips')
    expect(container.textContent).toBe('false')
    expect(useAppStore.getState().openModal).toHaveBeenCalledTimes(1)

    await act(async () => useAppStore.setState({ activeModal: 'none' }))
    expect(container.textContent).toBe('true')
  })

  it('waits for onboarding and suppresses a follow-up feature tip', async () => {
    await act(async () => {
      useAppStore.setState({ chatUiLaunchTipVariant: 'chat-ui-on' })
      gate.applyStartupOnboardingState(getDefaultOnboardingState())
    })
    expect(container.textContent).toBe('false')
    await loadOnboarding()
    expect(container.textContent).toBe('true')
    expect(useAppStore.getState().openModal).not.toHaveBeenCalled()
  })

  it('waits when dismissing the announcement opens another dialog', async () => {
    await act(async () => useAppStore.setState({ chatUiLaunchTipVariant: 'chat-ui-on' }))
    await loadOnboarding()
    await act(async () => useAppStore.setState({ activeModal: 'add-repo' }))
    expect(container.textContent).toBe('false')
    await act(async () => useAppStore.setState({ activeModal: 'none' }))
    expect(container.textContent).toBe('true')
  })
})
