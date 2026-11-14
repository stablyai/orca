// @vitest-environment happy-dom

import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState } from '../../../shared/onboarding-defaults'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import type { ChatUiLaunchTipVariant } from '../../../shared/native-chat/chat-ui-launch-tip-audience'
import type { FeatureTipSeenId } from '../../../shared/feature-tips'
import type { TelemetrySettings } from '../../../shared/telemetry-settings-types'
import { useAppStore } from '@/store'
import { useOnboardingAndFeatureTips } from './use-onboarding-and-feature-tips'

vi.mock('@/diagnostics/telemetry/telemetry', () => ({ track: vi.fn() }))

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

type Launch = {
  surface?: 'terminal' | 'chat'
  tip?: ChatUiLaunchTipVariant
  seen?: FeatureTipSeenId[]
  telemetry?: Partial<TelemetrySettings>
}

/** By default, a profile the tip skipped before: earlier launches already marked the older ids seen. */
const SKIPPED_BEFORE: Partial<TelemetrySettings> = {
  chatUiLaunchTipCohort: 'control',
  chatUiLaunchTipRolloutCohort: 'control'
}

async function launch({
  surface = 'terminal',
  tip = 'chat-ui-off',
  seen = ['chat-ui-here', 'chat-ui-here-rollout-v1'],
  telemetry = SKIPPED_BEFORE
}: Launch = {}): Promise<boolean> {
  vi.mocked(window.api.onboarding.getChatUiLaunchTipVariant).mockResolvedValue(tip)
  useAppStore.setState({
    persistedUIReady: true,
    featureTipsSeenIds: seen,
    settings: createGlobalSettingsFixture({
      agentDefaultSurface: surface,
      aiVaultSearch: { enabled: true, historyDays: null },
      telemetry: {
        optedIn: true,
        installId: 'install',
        existedBeforeTelemetryRelease: true,
        ...telemetry
      }
    })
  })
  await act(async () => root.render(<Gate />))
  return container.querySelector('output')?.textContent === 'true'
}

function expectNextTipInstead(): void {
  expect(useAppStore.getState().modalData).toMatchObject({ tipId: 'cmd-j-palette' })
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { set: vi.fn().mockResolvedValue(undefined) },
      cli: { getInstallStatus: vi.fn().mockResolvedValue({ supported: false }) },
      onboarding: { getChatUiLaunchTipVariant: vi.fn() }
    }
  })
  container = document.createElement('div')
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
})

it('shows the card once to a previously skipped profile on the terminal', async () => {
  expect(await launch()).toBe(true)
  expect(useAppStore.getState().featureTipsSeenIds).toContain('chat-ui-here-v2')
})

it('keeps a previously skipped profile on Chat UI out for good', async () => {
  expect(await launch({ surface: 'chat' })).toBe(false)
  expect(useAppStore.getState().featureTipsSeenIds).toContain('chat-ui-here-v2')
  expectNextTipInstead()
})
