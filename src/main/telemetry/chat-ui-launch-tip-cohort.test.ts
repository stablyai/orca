import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatUiLaunchTipVariant } from '../../shared/native-chat/chat-ui-launch-tip-audience'
import type { TelemetrySettings } from '../../shared/telemetry-settings-types'
import type { Store } from '../persistence'
import {
  ensureChatUiLaunchTipCohort,
  isChatUiLaunchTipDeferredForConsent
} from './chat-ui-launch-tip-cohort'
import { makeFakeSettings, restoreConsentEnv, stashAndClearConsentEnv } from './client-test-harness'

function makeStore(
  telemetry: Partial<TelemetrySettings>,
  variant: ChatUiLaunchTipVariant = 'chat-ui-off',
  seen: string[] = []
): Store {
  const settings = makeFakeSettings({
    optedIn: true,
    installId: 'install',
    existedBeforeTelemetryRelease: true,
    ...telemetry
  })
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
  })
  afterEach(() => {
    restoreConsentEnv(env)
  })

  it('enrolls a profile still due the tip once and keeps the frozen cohort', () => {
    const store = makeStore({})
    const cohort = ensureChatUiLaunchTipCohort(store)
    expect(['control', 'treatment']).toContain(cohort)
    expect(store.getSettings().telemetry?.chatUiLaunchTipCohort).toBe(cohort)
    expect(store.getSettings().telemetry?.installId).toBe('install')
    expect(ensureChatUiLaunchTipCohort(store)).toBe(cohort)
    expect(store.updateSettings).toHaveBeenCalledTimes(1)
  })

  it('holds the tip unenrolled while the banner is pending, then enrolls after acknowledgement', () => {
    const pending = makeStore({ optedIn: null })
    expect(ensureChatUiLaunchTipCohort(pending)).toBeUndefined()
    expect(isChatUiLaunchTipDeferredForConsent()).toBe(true)
    expect(pending.updateSettings).not.toHaveBeenCalled()

    // Acknowledging the banner persists optedIn=true; the next launch enrolls the still-unseen tip.
    pending.getSettings().telemetry!.optedIn = true
    const cohort = ensureChatUiLaunchTipCohort(pending)
    expect(['control', 'treatment']).toContain(cohort)
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
