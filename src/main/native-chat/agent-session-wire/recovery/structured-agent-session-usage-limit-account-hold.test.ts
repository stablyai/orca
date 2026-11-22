import { expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { LegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { NativeChatUsageLimitCut } from '../../../../shared/native-chat/transcript/continuation/native-chat-usage-limit-cut'
import { UsageLimitAccountHolds } from './structured-agent-session-usage-limit-account-hold'
import { cancelsCut } from './structured-agent-session-usage-limit-disposition'
import { usageLimitStopWithdrawal } from '../../../../shared/native-chat/transcript/continuation/native-chat-usage-limit-cut'
import { isOptionalUsageLimitContinueCancel } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-usage-limit-continue'

const HIT: LegacyAgentSessionAccountHome = { variable: 'CODEX_HOME', path: '/homes/spent' }
const NEXT: LegacyAgentSessionAccountHome = { variable: 'CODEX_HOME', path: '/homes/next' }
const ENDED = 1_000_000
const SWITCHED = ENDED + 60_000
// A cut whose reset the provider never said.
const CUT: NativeChatUsageLimitCut & { fence: number } = {
  turnItemId: 'turn-1',
  turnEndedAt: ENDED,
  fence: 3
}

function attributed(current: LegacyAgentSessionAccountHome, reading: ProviderRateLimits | null) {
  const holds = new UsageLimitAccountHolds()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution reads only these fields
  const host = {
    store: {
      getRecord: () => ({
        provider: 'codex',
        location: { wslDistro: null },
        launchedAccount: { fence: 3, accountHome: HIT }
      })
    },
    launchAccountHome: async () => current,
    usageLimitAutoContinue: {
      accountUsage: async () => ({
        scope: current.path,
        account: { key: current.path, read: () => reading, refresh: () => true }
      })
    }
  } as unknown as Parameters<UsageLimitAccountHolds['attribute']>[1]
  return holds.attribute('chat', host, CUT, SWITCHED).then(() => holds)
}

const reading = (session: { usedPercent: number; resetsAt: number }): ProviderRateLimits => ({
  provider: 'codex',
  session: { ...session, windowMinutes: 300, resetDescription: null },
  weekly: null,
  updatedAt: SWITCHED + 5_000,
  error: null,
  status: 'ok'
})

it('continues an unknown-reset cut once the chat moved to an account with room', async () => {
  const holds = await attributed(NEXT, reading({ usedPercent: 10, resetsAt: SWITCHED + 3_600_000 }))
  const cut = holds.withSwitchReset('chat', CUT)
  expect(cut.resetsAt).toBe(SWITCHED)
  expect(holds.schedulable('chat', cut, SWITCHED + 20_000)).toBe(true)
  expect(holds.ready('chat', { ...cut, resetsAt: SWITCHED }, SWITCHED + 20_000)).toBe(true)
})

it('holds it while the account it moved to is spent too', async () => {
  const spentUntil = SWITCHED + 3_600_000
  const holds = await attributed(NEXT, reading({ usedPercent: 100, resetsAt: spentUntil }))
  const cut = { ...holds.withSwitchReset('chat', CUT), resetsAt: SWITCHED }
  expect(holds.ready('chat', cut, SWITCHED + 20_000)).toBe(false)
  expect(holds.verdict('chat', cut, SWITCHED + 20_000).resetsAt).toBe(spentUntil)
})

it('leaves an unknown reset unknown when the chat never moved accounts', async () => {
  const holds = await attributed(HIT, reading({ usedPercent: 10, resetsAt: SWITCHED + 3_600_000 }))
  const cut = holds.withSwitchReset('chat', CUT)
  expect(cut.resetsAt).toBeUndefined()
  expect(holds.schedulable('chat', cut, SWITCHED + 20_000)).toBe(false)
})

it("a person's Stop withdraws the continue a switch gives an unknown-reset cut", async () => {
  const holds = await attributed(NEXT, reading({ usedPercent: 10, resetsAt: SWITCHED + 3_600_000 }))
  // What the Stop records, read from the journal's own cut (no switch time is kept there).
  const withdrawal = usageLimitStopWithdrawal(CUT)
  expect(isOptionalUsageLimitContinueCancel(withdrawal)).toBe(true)
  expect(cancelsCut(withdrawal, holds.withSwitchReset('chat', CUT))).toBe(true)
})

const WEEKLY_RESET = ENDED + 4 * 86_400_000
const weekly = (usedPercent: number, updatedAt: number): ProviderRateLimits => ({
  provider: 'codex',
  session: null,
  weekly: { usedPercent, resetsAt: WEEKLY_RESET, windowMinutes: 10_080, resetDescription: null },
  updatedAt,
  error: null,
  status: 'ok'
})

async function sameFolder(readings: ProviderRateLimits[]) {
  let current = readings[0]!
  const holds = new UsageLimitAccountHolds()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution reads only these fields
  const host = {
    store: {
      getRecord: () => ({
        provider: 'codex',
        location: { wslDistro: null },
        launchedAccount: { fence: 3, accountHome: HIT }
      })
    },
    launchAccountHome: async () => HIT,
    usageLimitAutoContinue: {
      accountUsage: async () => ({
        scope: HIT.path,
        account: { key: HIT.path, read: () => current, refresh: () => true }
      })
    }
  } as unknown as Parameters<UsageLimitAccountHolds['attribute']>[1]
  const cut = { ...CUT, resetsAt: WEEKLY_RESET }
  await holds.attribute('chat', host, cut, SWITCHED)
  for (const next of readings) {
    current = next
    holds.verdict('chat', cut, next.updatedAt)
  }
  return { holds, cut }
}

it('continues before the reset once the same folder, seen spent, reads with room (a new login)', async () => {
  const { holds, cut } = await sameFolder([weekly(100, SWITCHED), weekly(5, SWITCHED + 60_000)])
  expect(holds.ready('chat', cut, SWITCHED + 90_000)).toBe(true)
})

it('keeps the reset when the folder was never seen spent: room alone may not cover the limit hit', async () => {
  const { holds, cut } = await sameFolder([weekly(5, SWITCHED), weekly(5, SWITCHED + 60_000)])
  expect(holds.ready('chat', cut, SWITCHED + 90_000)).toBe(false)
})
