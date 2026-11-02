// @vitest-environment happy-dom

import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureTipId } from '../../../shared/feature-tips'
import { getDefaultOnboardingState } from '../../../shared/onboarding-defaults'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import type { TelemetrySettings } from '../../../shared/telemetry-settings-types'
import type * as telemetry from '@/lib/telemetry'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import { wasChatUiLaunchTipShown } from '../components/feature-tips/feature-tip-telemetry'
import { useOnboardingAndFeatureTips } from './use-onboarding-and-feature-tips'

const telemetryMock = vi.hoisted(() => ({ passThrough: false }))
// Pass-through lets one test drive the real bridge wrapper against a rejecting main.
vi.mock('@/lib/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof telemetry>()
  return {
    track: vi.fn((...args: Parameters<typeof actual.track>) => {
      if (telemetryMock.passThrough) {
        actual.track(...args)
      }
    })
  }
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function Gate(): JSX.Element | null {
  const gate = useOnboardingAndFeatureTips()
  if (gate.onboarding === null) {
    gate.applyStartupOnboardingState({ ...getDefaultOnboardingState(), closedAt: 1 })
  }
  return <output>{String(gate.chatUiHereCornerCardOpen)}</output>
}

async function launch(
  cohort: TelemetrySettings['chatUiLaunchTipCohort'],
  targeting?: TelemetrySettings['chatUiLaunchTipTargeting']
): Promise<void> {
  const markFeatureTipsSeen = vi.fn((ids: FeatureTipId[]) =>
    useAppStore.setState((state) => ({ featureTipsSeenIds: [...state.featureTipsSeenIds, ...ids] }))
  )
  useAppStore.setState({
    persistedUIReady: true,
    featureTipsSeenIds: [],
    settings: createGlobalSettingsFixture({
      aiVaultSearch: { enabled: true, historyDays: null },
      telemetry: {
        optedIn: true,
        installId: 'install',
        existedBeforeTelemetryRelease: true,
        ...(cohort ? { chatUiLaunchTipCohort: cohort } : {}),
        ...(targeting ? { chatUiLaunchTipTargeting: targeting } : {})
      }
    }),
    markFeatureTipsSeen
  })
  await act(async () => root.render(<Gate />))
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.mocked(track).mockClear()
  telemetryMock.passThrough = false
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { set: vi.fn().mockResolvedValue(undefined) },
      cli: { getInstallStatus: vi.fn().mockResolvedValue({ supported: false }) },
      onboarding: { getChatUiLaunchTipVariant: vi.fn().mockResolvedValue('chat-ui-off') }
    }
  })
  container = document.createElement('div')
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
})

describe('Chat UI launch tip holdout', () => {
  it.each([
    [undefined, 'unassigned'],
    ['treatment', 'treatment'],
    ['treatment-live-switch', 'treatment-live-switch'],
    ['treatment-swapped-buttons', 'treatment-swapped-buttons']
  ] as const)(
    'opens the corner card for %s profiles after recording exposure',
    async (cohort, label) => {
      await launch(cohort)
      expect(container.querySelector('output')?.textContent).toBe('true')
      expect(useAppStore.getState().activeModal).toBe('none')
      expect(track).toHaveBeenCalledWith('chat_ui_feature_tip_exposure', {
        variant: 'chat_ui_off',
        launch_tip_cohort: label,
        shown: true
      })
      expect(track).toHaveBeenCalledWith('chat_ui_feature_tip_shown', { variant: 'chat_ui_off' })
    }
  )

  it('opens the center dialog for the center cohort', async () => {
    await launch('treatment-center', { mode: 'not-switched', eligible: true })
    expect(container.querySelector('output')?.textContent).toBe('false')
    expect(useAppStore.getState().modalData).toMatchObject({ tipId: 'chat-ui-here' })
  })

  it('holds back the not-switched targeting group when ineligible', async () => {
    await launch('treatment-center', { mode: 'not-switched', eligible: false })
    expect(useAppStore.getState().modalData).toMatchObject({ tipId: 'cmd-j-palette' })
  })

  it('records control exposure without showing the tip, then lets the next tip open', async () => {
    await launch('control')
    expect(track).toHaveBeenCalledWith('chat_ui_feature_tip_exposure', {
      variant: 'chat_ui_off',
      launch_tip_cohort: 'control',
      shown: false
    })
    expect(track).not.toHaveBeenCalledWith('chat_ui_feature_tip_shown', expect.anything())
    expect(useAppStore.getState().featureTipsSeenIds).toContain('chat-ui-here')
    expect(useAppStore.getState().activeModal).toBe('feature-tips')
    expect(useAppStore.getState().modalData).toMatchObject({ tipId: 'cmd-j-palette' })
  })

  it.each(['chat-ui-off', 'chat-ui-on'] as const)(
    'suppresses the %s card when no harness qualifies',
    async (variant) => {
      vi.mocked(window.api.onboarding.getChatUiLaunchTipVariant).mockResolvedValue(variant)
      await launch('treatment', { mode: 'eligible-harnesses', eligible: false })
      expect(track).toHaveBeenCalledWith('chat_ui_feature_tip_exposure', {
        variant: variant === 'chat-ui-off' ? 'chat_ui_off' : 'chat_ui_on',
        launch_tip_cohort: 'treatment',
        targeting: 'eligible-harnesses',
        shown: false
      })
      expect(useAppStore.getState().modalData).toMatchObject({ tipId: 'cmd-j-palette' })
      expect(container.querySelector('output')?.textContent).toBe('false')
      expect(
        wasChatUiLaunchTipShown(
          useAppStore.getState().featureTipsSeenIds,
          useAppStore.getState().settings
        )
      ).toBe(false)
    }
  )

  it.each(['treatment-live-switch', 'treatment-swapped-buttons'] as const)(
    'suppresses the %s card when no harness qualifies',
    async (cohort) => {
      await launch(cohort, { mode: 'eligible-harnesses', eligible: false })
      expect(container.querySelector('output')?.textContent).toBe('false')
      expect(track).toHaveBeenCalledWith('chat_ui_feature_tip_exposure', {
        variant: 'chat_ui_off',
        launch_tip_cohort: cohort,
        targeting: 'eligible-harnesses',
        shown: false
      })
      expect(useAppStore.getState().modalData).toMatchObject({ tipId: 'cmd-j-palette' })
    }
  )

  it.each([
    { variant: 'chat-ui-off', targeting: { mode: 'all' } },
    { variant: 'chat-ui-on', targeting: { mode: 'all' } },
    { variant: 'chat-ui-off', targeting: { mode: 'eligible-harnesses', eligible: true } },
    { variant: 'chat-ui-on', targeting: { mode: 'eligible-harnesses', eligible: true } }
  ] as const)('shows $variant with $targeting.mode targeting', async ({ variant, targeting }) => {
    vi.mocked(window.api.onboarding.getChatUiLaunchTipVariant).mockResolvedValue(variant)
    await launch('treatment', targeting)
    expect(container.querySelector('output')?.textContent).toBe(String(variant === 'chat-ui-off'))
    if (variant === 'chat-ui-on') {
      expect(useAppStore.getState().modalData).toMatchObject({ tipId: 'chat-ui-here' })
    } else {
      expect(useAppStore.getState().activeModal).toBe('none')
    }
    expect(track).toHaveBeenCalledWith('chat_ui_feature_tip_exposure', {
      variant: variant === 'chat-ui-off' ? 'chat_ui_off' : 'chat_ui_on',
      launch_tip_cohort: 'treatment',
      targeting: targeting.mode,
      shown: true
    })
    const { settings, featureTipsSeenIds } = useAppStore.getState()
    expect(wasChatUiLaunchTipShown(featureTipsSeenIds, settings)).toBe(true)
    await act(async () => {
      useAppStore.setState({
        settings: settings ? { ...settings, agentDefaultSurface: 'chat' } : null
      })
    })
    expect(wasChatUiLaunchTipShown(featureTipsSeenIds, useAppStore.getState().settings)).toBe(true)
    expect(
      vi.mocked(track).mock.calls.filter(([event]) => event === 'chat_ui_feature_tip_exposure')
    ).toHaveLength(1)
  })

  // Exposure is best-effort: a rejected capture (consent flip, session budget, IPC failure) is not
  // retried, and the tip stays consumed so a failed send never shows it twice.
  it.each(['treatment', 'control'] as const)(
    'keeps the %s tip consumed when main rejects the exposure event',
    async (cohort) => {
      telemetryMock.passThrough = true
      const telemetryTrack = vi.fn().mockResolvedValue(false)
      Object.assign(window.api, { telemetryTrack })
      await launch(cohort)
      expect(telemetryTrack).toHaveBeenCalledWith('chat_ui_feature_tip_exposure', {
        variant: 'chat_ui_off',
        launch_tip_cohort: cohort,
        shown: cohort === 'treatment'
      })
      expect(useAppStore.getState().featureTipsSeenIds).toContain('chat-ui-here')
      if (cohort === 'treatment') {
        expect(container.querySelector('output')?.textContent).toBe('true')
        expect(useAppStore.getState().activeModal).toBe('none')
      } else {
        expect(container.querySelector('output')?.textContent).toBe('false')
        expect(useAppStore.getState().modalData).toMatchObject({ tipId: 'cmd-j-palette' })
      }
    }
  )
})
