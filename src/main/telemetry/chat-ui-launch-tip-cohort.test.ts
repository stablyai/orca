import * as crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatUiLaunchTipVariant } from '../../shared/native-chat/chat-ui-launch-tip-audience'
import type { TelemetrySettings } from '../../shared/telemetry-settings-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Store } from '../persistence/loading-store/store'
import {
  ensureChatUiLaunchTipCohort,
  isChatUiLaunchTipDeferredForConsent
} from './chat-ui-launch-tip-cohort'
import { experimentCohortProps } from './experiment-cohort-props'
import { commonPropsSchema } from '../../shared/telemetry-events'
import {
  BASE_COMMON,
  makeFakeSettings,
  restoreConsentEnv,
  stashAndClearConsentEnv
} from './client-test-harness'

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof crypto>()),
  randomInt: vi.fn(() => 0)
}))

function makeStore(
  telemetry: Partial<TelemetrySettings>,
  variant: ChatUiLaunchTipVariant = 'chat-ui-off',
  seen: string[] = [],
  preferences: Partial<GlobalSettings> = {}
): Store {
  const settings = makeFakeSettings({
    optedIn: true,
    installId: 'install',
    existedBeforeTelemetryRelease: true,
    ...telemetry
  })
  Object.assign(settings, preferences)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies every Store method the cohort assignment reads or writes.
  return {
    getSettings: () => settings,
    getUI: () => ({ featureTipsSeenIds: seen }),
    getChatUiLaunchTipVariant: () => variant,
    updateSettings: vi.fn((updates: { telemetry: TelemetrySettings }) => {
      settings.telemetry = updates.telemetry
    })
  } as unknown as Store
}

describe('ensureChatUiLaunchTipCohort', () => {
  let env: Record<string, string | undefined>
  beforeEach(() => {
    env = stashAndClearConsentEnv()
    vi.mocked(crypto.randomInt)
      .mockReset()
      .mockImplementation(() => 0)
  })
  afterEach(() => {
    restoreConsentEnv(env)
  })

  it.each([
    { draw: 0, cohort: 'control' },
    { draw: 1, cohort: 'control' },
    { draw: 2, cohort: 'control' },
    { draw: 3, cohort: 'control' },
    { draw: 4, cohort: 'control' },
    { draw: 5, cohort: 'control' },
    { draw: 6, cohort: 'control' },
    { draw: 7, cohort: 'treatment-center' },
    { draw: 8, cohort: 'treatment' },
    { draw: 9, cohort: 'treatment-live-switch' }
  ])('assigns draw $draw to $cohort and keeps the frozen cohort', ({ draw, cohort }) => {
    vi.mocked(crypto.randomInt).mockImplementationOnce(() => draw)
    const store = makeStore({})
    expect(ensureChatUiLaunchTipCohort(store)).toBe(cohort)
    expect(crypto.randomInt).toHaveBeenNthCalledWith(1, 10)
    expect(store.getSettings().telemetry?.chatUiLaunchTipCohort).toBe(cohort)
    expect(store.getSettings().telemetry?.installId).toBe('install')
    expect(ensureChatUiLaunchTipCohort(store)).toBe(cohort)
    expect(store.updateSettings).toHaveBeenCalledTimes(1)
  })

  it.each([0, 1])('freezes button emphasis draw %s independently', (draw) => {
    vi.mocked(crypto.randomInt)
      .mockImplementationOnce(() => 7)
      .mockImplementationOnce(() => 0)
      .mockImplementationOnce(() => draw)
    const store = makeStore({})
    expect(ensureChatUiLaunchTipCohort(store)).toBe('treatment-center')
    expect(store.getSettings().telemetry?.chatUiLaunchTipButtonEmphasis).toBe(
      draw === 0 ? 'normal' : 'swapped'
    )
    ensureChatUiLaunchTipCohort(store)
    expect(store.updateSettings).toHaveBeenCalledTimes(1)
  })

  it.each([
    { variant: 'chat-ui-off', surface: 'terminal' },
    { variant: 'chat-ui-off', surface: 'chat' },
    { variant: 'chat-ui-on', surface: 'terminal' },
    { variant: 'chat-ui-on', surface: 'chat' },
    { variant: 'chat-ui-on', surface: undefined }
  ] as const)(
    'targets the current $surface default for the frozen $variant audience and preserves enrollment',
    ({ variant, surface }) => {
      for (const draw of [0, 1]) {
        vi.mocked(crypto.randomInt)
          .mockReset()
          .mockImplementationOnce(() => 8)
          .mockImplementationOnce(() => draw)
        const store = makeStore({}, variant, [], { agentDefaultSurface: surface })
        expect(ensureChatUiLaunchTipCohort(store)).toBe('treatment')
        expect(crypto.randomInt).toHaveBeenNthCalledWith(1, 10)
        expect(crypto.randomInt).toHaveBeenNthCalledWith(2, 2)
        const targeting = store.getSettings().telemetry?.chatUiLaunchTipTargeting
        expect(targeting).toEqual(
          draw === 0 ? { mode: 'all' } : { mode: 'not-switched', eligible: surface !== 'chat' }
        )
        store.getSettings().agentDefaultSurface = surface === 'chat' ? 'terminal' : 'chat'
        expect(ensureChatUiLaunchTipCohort(store)).toBe('treatment')
        expect(store.getSettings().telemetry?.chatUiLaunchTipTargeting).toEqual(targeting)
        expect(store.getChatUiLaunchTipVariant()).toBe(variant)
        expect(store.updateSettings).toHaveBeenCalledTimes(1)
      }
    }
  )

  it.each([
    { variant: 'chat-ui-off', before: 'terminal', atEnrollment: 'chat', eligible: false },
    { variant: 'chat-ui-on', before: 'chat', atEnrollment: 'terminal', eligible: true }
  ] as const)(
    'uses the $atEnrollment default after consent delays enrollment for $variant',
    ({ variant, before, atEnrollment, eligible }) => {
      vi.mocked(crypto.randomInt)
        .mockImplementationOnce(() => 8)
        .mockImplementationOnce(() => 1)
      const store = makeStore({ optedIn: null }, variant, [], { agentDefaultSurface: before })
      expect(ensureChatUiLaunchTipCohort(store)).toBeUndefined()
      expect(crypto.randomInt).not.toHaveBeenCalled()

      store.getSettings().agentDefaultSurface = atEnrollment
      store.getSettings().telemetry!.optedIn = true
      expect(ensureChatUiLaunchTipCohort(store)).toBe('treatment')
      expect(store.getSettings().telemetry?.chatUiLaunchTipTargeting).toEqual({
        mode: 'not-switched',
        eligible
      })
      expect(store.getChatUiLaunchTipVariant()).toBe(variant)
    }
  )

  it.each([
    'control',
    'treatment-center',
    'treatment',
    'treatment-live-switch',
    'treatment-swapped-buttons'
  ] as const)('preserves existing %s assignments', (cohort) => {
    const store = makeStore({ chatUiLaunchTipCohort: cohort })
    expect(ensureChatUiLaunchTipCohort(store)).toBe(cohort)
    expect(crypto.randomInt).not.toHaveBeenCalled()
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

  it.each([
    { draw: 7, cohort: 'treatment-center' },
    { draw: 8, cohort: 'treatment' },
    { draw: 9, cohort: 'treatment-live-switch' }
  ])(
    'emits schema-valid targeting props immediately after $cohort enrollment',
    ({ draw, cohort }) => {
      vi.mocked(crypto.randomInt)
        .mockImplementationOnce(() => draw)
        .mockImplementationOnce(() => 1)
      const store = makeStore({ onboardingLanguageCohort: 'treatment' })
      const props = experimentCohortProps(store)
      expect(props).toEqual({
        onboarding_language_v1: 'treatment',
        chat_ui_launch_tip_v1: cohort,
        chat_ui_launch_tip_targeting_v1: 'not-switched',
        chat_ui_launch_tip_button_emphasis_v1: 'normal'
      })
      expect(commonPropsSchema.safeParse({ ...BASE_COMMON, ...props }).success).toBe(true)
    }
  )

  it('ignores malformed targeting metadata rather than disabling all telemetry', () => {
    const store = makeStore({ chatUiLaunchTipCohort: 'treatment' })
    Object.assign(store.getSettings().telemetry!, { chatUiLaunchTipTargeting: { mode: 'invalid' } })
    const props = experimentCohortProps(store)
    expect(props.chat_ui_launch_tip_targeting_v1).toBeUndefined()
    expect(commonPropsSchema.safeParse({ ...BASE_COMMON, ...props }).success).toBe(true)
  })

  it('holds the tip unenrolled while the banner is pending, then enrolls after acknowledgement', () => {
    const pending = makeStore({ optedIn: null })
    expect(ensureChatUiLaunchTipCohort(pending)).toBeUndefined()
    expect(isChatUiLaunchTipDeferredForConsent()).toBe(true)
    expect(pending.updateSettings).not.toHaveBeenCalled()

    // Acknowledging the banner persists optedIn=true; the next launch enrolls the still-unseen tip.
    pending.getSettings().telemetry!.optedIn = true
    const cohort = ensureChatUiLaunchTipCohort(pending)
    expect([
      'control',
      'treatment',
      'treatment-live-switch',
      'treatment-swapped-buttons'
    ]).toContain(cohort)
    expect(isChatUiLaunchTipDeferredForConsent()).toBe(false)
    expect(pending.getSettings().telemetry?.chatUiLaunchTipCohort).toBe(cohort)
  })

  it('releases a pending profile unenrolled after the banner is declined, so the tip shows as before', () => {
    const pending = makeStore({ optedIn: null })
    ensureChatUiLaunchTipCohort(pending)
    expect(isChatUiLaunchTipDeferredForConsent()).toBe(true)

    pending.getSettings().telemetry!.optedIn = false
    expect(ensureChatUiLaunchTipCohort(pending)).toBeUndefined()
    expect(isChatUiLaunchTipDeferredForConsent()).toBe(false)
    expect(pending.updateSettings).not.toHaveBeenCalled()
  })

  it.each([
    ['outside the audience', makeStore({}, 'none')],
    ['already shown the tip', makeStore({}, 'chat-ui-off', ['chat-ui-here'])],
    ['opted out', makeStore({ optedIn: false })]
  ])('leaves a profile %s unenrolled, so it keeps today’s behaviour', (_label, store) => {
    expect(ensureChatUiLaunchTipCohort(store)).toBeUndefined()
    expect(isChatUiLaunchTipDeferredForConsent()).toBe(false)
    expect(store.updateSettings).not.toHaveBeenCalled()
  })
})
