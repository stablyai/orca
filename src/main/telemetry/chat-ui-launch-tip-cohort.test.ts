import * as crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatUiLaunchTipVariant } from '../../shared/native-chat/chat-ui-launch-tip-audience'
import type { TelemetrySettings } from '../../shared/telemetry-settings-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { TUI_AGENT_AUTO_PICK_ORDER } from '../../shared/tui-agent-selection'
import type { Store } from '../persistence/loading-store/store'
import {
  ensureChatUiLaunchTipCohort as assignCohort,
  isChatUiLaunchTipDeferredForConsent
} from './chat-ui-launch-tip-cohort'
import { experimentCohortProps } from './experiment-cohort-props'
import { commonPropsSchema } from '../../shared/telemetry-events'
import { hasChatUiLaunchTipEligibleHarness } from '../native-chat/chat-ui-launch-tip-targeting'
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

function ensureChatUiLaunchTipCohort(store: Store) {
  return assignCohort(store, hasChatUiLaunchTipEligibleHarness)
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
    { draw: 7, cohort: 'control' },
    { draw: 8, cohort: 'treatment' },
    { draw: 9, cohort: 'treatment-live-switch' }
  ])('assigns draw $draw to $cohort and keeps the frozen cohort', ({ draw, cohort }) => {
    vi.mocked(crypto.randomInt).mockImplementation(() => draw)
    const store = makeStore({})
    expect(ensureChatUiLaunchTipCohort(store)).toBe(cohort)
    expect(crypto.randomInt).toHaveBeenCalledWith(10)
    expect(store.getSettings().telemetry?.chatUiLaunchTipCohort).toBe(cohort)
    expect(store.getSettings().telemetry?.installId).toBe('install')
    expect(ensureChatUiLaunchTipCohort(store)).toBe(cohort)
    expect(store.updateSettings).toHaveBeenCalledTimes(1)
  })

  it.each(['chat-ui-off', 'chat-ui-on'] as const)(
    'splits the %s card treatment equally and freezes eligibility across restarts',
    (variant) => {
      for (const draw of [0, 1]) {
        vi.mocked(crypto.randomInt)
          .mockReset()
          .mockImplementationOnce(() => 8)
          .mockImplementationOnce(() => draw)
        const store = makeStore({}, variant, [], { agentDefaultSurface: 'terminal' })
        expect(ensureChatUiLaunchTipCohort(store)).toBe('treatment')
        expect(crypto.randomInt).toHaveBeenNthCalledWith(1, 10)
        expect(crypto.randomInt).toHaveBeenNthCalledWith(2, 2)
        const targeting = store.getSettings().telemetry?.chatUiLaunchTipTargeting
        expect(targeting).toEqual(
          draw === 0 ? { mode: 'all' } : { mode: 'eligible-harnesses', eligible: true }
        )
        store.getSettings().agentDefaultSurface = 'chat'
        expect(ensureChatUiLaunchTipCohort(store)).toBe('treatment')
        expect(store.getSettings().telemetry?.chatUiLaunchTipTargeting).toEqual(targeting)
        expect(store.updateSettings).toHaveBeenCalledTimes(1)
      }
    }
  )

  it.each([
    {
      name: 'all Chat',
      enabled: ['claude', 'codex'],
      surface: 'chat',
      overrides: {},
      eligible: false
    },
    {
      name: 'CLI-only harness',
      enabled: ['aider'],
      surface: 'terminal',
      overrides: {},
      eligible: false
    },
    {
      name: 'Chat plus CLI-only harness',
      enabled: ['codex', 'aider'],
      surface: 'chat',
      overrides: { aider: false },
      eligible: false
    },
    {
      name: 'per-harness CLI override',
      enabled: ['codex'],
      surface: 'chat',
      overrides: { codex: false },
      eligible: true
    },
    {
      name: 'per-harness Chat override',
      enabled: ['codex'],
      surface: 'terminal',
      overrides: { codex: true },
      eligible: false
    },
    {
      name: 'mixed supported harnesses',
      enabled: ['claude', 'codex'],
      surface: 'chat',
      overrides: { claude: false },
      eligible: true
    },
    { name: 'all disabled', enabled: [], surface: 'terminal', overrides: {}, eligible: false }
  ] as const)('targets $name using settings only', ({ enabled, surface, overrides, eligible }) => {
    vi.mocked(crypto.randomInt)
      .mockImplementationOnce(() => 8)
      .mockImplementationOnce(() => 1)
    const store = makeStore({}, 'chat-ui-off', [], {
      agentDefaultSurface: surface,
      nativeChatProviders: overrides,
      disabledTuiAgents: TUI_AGENT_AUTO_PICK_ORDER.filter(
        (agent) => !enabled.some((candidate) => candidate === agent)
      )
    })
    ensureChatUiLaunchTipCohort(store)
    expect(store.getSettings().telemetry?.chatUiLaunchTipTargeting).toEqual({
      mode: 'eligible-harnesses',
      eligible
    })
  })

  it.each(['control', 'treatment', 'treatment-live-switch'] as const)(
    'preserves existing %s assignments',
    (cohort) => {
      const store = makeStore({ chatUiLaunchTipCohort: cohort })
      expect(ensureChatUiLaunchTipCohort(store)).toBe(cohort)
      expect(crypto.randomInt).not.toHaveBeenCalled()
      expect(store.updateSettings).not.toHaveBeenCalled()
    }
  )

  it('keeps failed capability checks in the filtered arm without showing everyone instead', () => {
    vi.mocked(crypto.randomInt)
      .mockImplementationOnce(() => 8)
      .mockImplementationOnce(() => 1)
    const resolve = vi.fn(() => {
      throw new Error('capability check unavailable')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = makeStore({})
      expect(assignCohort(store, resolve)).toBe('treatment')
      expect(store.getSettings().telemetry?.chatUiLaunchTipTargeting).toEqual({
        mode: 'eligible-harnesses',
        eligible: false
      })
      expect(assignCohort(store, resolve)).toBe('treatment')
      expect(resolve).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('emits schema-valid targeting props immediately after enrollment without harness settings', () => {
    vi.mocked(crypto.randomInt)
      .mockImplementationOnce(() => 8)
      .mockImplementationOnce(() => 1)
    const store = makeStore({ onboardingLanguageCohort: 'treatment' })
    const props = experimentCohortProps(store, hasChatUiLaunchTipEligibleHarness)
    expect(props).toEqual({
      onboarding_language_v1: 'treatment',
      chat_ui_launch_tip_v1: 'treatment',
      chat_ui_launch_tip_targeting_v1: 'eligible-harnesses'
    })
    expect(commonPropsSchema.safeParse({ ...BASE_COMMON, ...props }).success).toBe(true)
  })

  it('ignores malformed targeting metadata rather than disabling all telemetry', () => {
    const store = makeStore({ chatUiLaunchTipCohort: 'treatment' })
    Object.assign(store.getSettings().telemetry!, { chatUiLaunchTipTargeting: { mode: 'invalid' } })
    const props = experimentCohortProps(store, hasChatUiLaunchTipEligibleHarness)
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
    expect(['control', 'treatment', 'treatment-live-switch']).toContain(cohort)
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
