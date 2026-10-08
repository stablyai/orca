// @vitest-environment happy-dom

import { act, lazy, Suspense, type LazyExoticComponent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { getDefaultOnboardingState } from '../../../shared/onboarding-defaults'
import { useAppStore } from '@/store'
import { useDialogRegistry } from '@/store/dialog-registry'
import { resetDialogRegistryForTests } from '@/store/dialog-registry-test-state'
import { ContextualTourOverlay } from '../components/contextual-tours/ContextualTourOverlay'
import { useContextualTour } from '../components/contextual-tours/use-contextual-tour'
import OnboardingFlow from '../components/onboarding/OnboardingFlow'
import { showOnboardingFromRenderer } from '../components/onboarding/show-onboarding-event'
import { useOnboardingAndFeatureTips, type OnboardingGate } from './use-onboarding-and-feature-tips'

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackContextualTourShown: vi.fn(),
  trackContextualTourOutcome: vi.fn()
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
let target: HTMLButtonElement
let gate: OnboardingGate | null
let chunk: ReturnType<typeof Promise.withResolvers<{ default: typeof OnboardingFlow }>>
let LazyOnboarding: LazyExoticComponent<typeof OnboardingFlow>

function App(): React.JSX.Element {
  const onboarding = useOnboardingAndFeatureTips()
  gate = onboarding
  useContextualTour('automations', true, 'automations_open', { recordFeatureInteraction: false })
  return (
    <>
      {onboarding.onboarding && onboarding.shouldRender ? (
        <Suspense fallback={null}>
          <LazyOnboarding
            onboarding={onboarding.onboarding}
            onOnboardingChange={onboarding.setOnboarding}
          />
        </Suspense>
      ) : null}
      <ContextualTourOverlay />
    </>
  )
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
  }
}

beforeEach(() => {
  gate = null
  chunk = Promise.withResolvers()
  LazyOnboarding = lazy(() => chunk.promise)
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: getDefaultSettings(''),
    persistedUIReady: true,
    contextualToursAutoEligible: true,
    refreshDetectedAgents: vi.fn(async () => []),
    refreshPreflightStatus: vi.fn(async () => {})
  })
  resetDialogRegistryForTests({ startupSettled: true })
  Object.assign(window, {
    api: {
      ui: { set: vi.fn(async () => undefined) },
      onboarding: { update: vi.fn(async () => getDefaultOnboardingState()) },
      cli: { getInstallStatus: vi.fn(async () => ({ supported: false })) }
    }
  })
  target = document.createElement('button')
  target.dataset.contextualTourTarget = 'automations-create'
  target.getBoundingClientRect = () => new DOMRect(100, 100, 120, 40)
  document.body.append(target)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  target.remove()
  container.remove()
})

it('does not consume a restored-page tour before first-run onboarding content commits', async () => {
  await act(async () => root.render(<App />))
  act(() => gate?.applyStartupOnboardingState(getDefaultOnboardingState()))
  await settle()

  expect(useAppStore.getState().contextualToursAutoEligible).toBe(true)
  expect(Object.values(useDialogRegistry.getState().startupSources)).not.toContain('pending')
  expect({
    onboardingMounted: container.querySelector('[data-onboarding-modal]') !== null,
    contentKinds: useDialogRegistry.getState().dialogEntries.map((entry) => entry.kind),
    activeTour: useAppStore.getState().activeContextualTourId,
    shown: useAppStore.getState().contextualTourShownThisSession,
    seen: useAppStore.getState().contextualToursSeenIds
  }).toEqual({
    onboardingMounted: false,
    contentKinds: [],
    activeTour: null,
    shown: false,
    seen: []
  })
  act(() =>
    useAppStore.getState().requestContextualTour('automations', 'automations_open', false, {
      force: true
    })
  )
  expect(useAppStore.getState().activeContextualTourId).toBeNull()

  await act(async () => chunk.resolve({ default: OnboardingFlow }))
  await settle()
  expect(container.querySelector('[data-onboarding-modal]')).not.toBeNull()
  expect(useDialogRegistry.getState().dialogEntries.map((entry) => entry.kind)).toEqual([
    'onboarding'
  ])
  expect(useAppStore.getState().contextualToursSeenIds).toEqual([])

  act(() =>
    gate?.setOnboarding({ ...getDefaultOnboardingState(), closedAt: 1, outcome: 'completed' })
  )
  await settle()
  expect(useAppStore.getState().activeContextualTourId).toBe('automations')
  expect(useAppStore.getState().contextualToursSeenIds).toEqual(['automations'])
})

it('waits for unknown onboarding even when the profile already belongs to the automatic-tour cohort', async () => {
  await act(async () => root.render(<App />))
  await settle()

  expect(useDialogRegistry.getState().dialogEntries).toEqual([])
  expect(useAppStore.getState().activeContextualTourId).toBeNull()
  expect(useAppStore.getState().contextualToursSeenIds).toEqual([])

  act(() =>
    gate?.applyStartupOnboardingState({
      ...getDefaultOnboardingState(),
      closedAt: 1,
      outcome: 'completed'
    })
  )
  await settle()
  expect(useAppStore.getState().activeContextualTourId).toBe('automations')
  expect(useAppStore.getState().contextualToursSeenIds).toEqual(['automations'])
})

it('cancels a shown tour when onboarding is reopened before its content mounts', async () => {
  await act(async () => root.render(<App />))
  act(() =>
    gate?.applyStartupOnboardingState({
      ...getDefaultOnboardingState(),
      closedAt: 1,
      outcome: 'completed'
    })
  )
  await settle()
  expect(useAppStore.getState().activeContextualTourId).toBe('automations')

  await act(async () => showOnboardingFromRenderer())
  await settle()

  expect(container.querySelector('[data-onboarding-modal]')).toBeNull()
  expect(useDialogRegistry.getState().dialogEntries).toEqual([])
  expect(useAppStore.getState().activeContextualTourId).toBeNull()
  expect(useAppStore.getState().contextualToursSeenIds).toEqual(['automations'])
})
