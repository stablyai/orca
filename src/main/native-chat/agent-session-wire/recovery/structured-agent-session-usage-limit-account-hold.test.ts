import { expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { LegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import {
  NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS,
  usageLimitStopWithdrawal,
  type NativeChatUsageLimitCut
} from '../../../../shared/native-chat/transcript/continuation/native-chat-usage-limit-cut'
import { UsageLimitAccountHolds } from './structured-agent-session-usage-limit-account-hold'
import { cancelsCut } from './structured-agent-session-usage-limit-disposition'
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
        launchedAccount: { fence: 3, accountHome: HIT },
        lease: { runtimeFence: 3 }
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

it('does not use an old-account reading after a moved chat changes reading source', async () => {
  let current = true
  const holds = new UsageLimitAccountHolds()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution reads only these fields
  const host = {
    store: {
      getRecord: () => ({
        provider: 'codex',
        location: { wslDistro: null },
        launchedAccount: { fence: 3, accountHome: HIT },
        lease: { runtimeFence: 3 }
      })
    },
    launchAccountHome: async () => NEXT,
    usageLimitAutoContinue: {
      accountUsage: async () => ({
        scope: NEXT.path,
        account: {
          key: NEXT.path,
          read: () => (current ? reading({ usedPercent: 0, resetsAt: SWITCHED }) : null),
          refresh: () => true
        }
      })
    }
  } as unknown as Parameters<UsageLimitAccountHolds['attribute']>[1]
  await holds.attribute('chat', host, CUT, SWITCHED)
  current = false
  const cut = { ...holds.withSwitchReset('chat', CUT), resetsAt: SWITCHED }
  expect(holds.ready('chat', cut, SWITCHED + 20_000)).toBe(false)
})

it('keeps stale known spending on a moved account past the reading wait', async () => {
  const holds = new UsageLimitAccountHolds()
  const exhausted = {
    ...reading({ usedPercent: 100, resetsAt: SWITCHED + 3_600_000 }),
    updatedAt: ENDED - 1
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution reads only these fields
  const host = {
    store: {
      getRecord: () => ({
        provider: 'codex',
        location: { wslDistro: null },
        launchedAccount: { fence: 3, accountHome: HIT },
        lease: { runtimeFence: 3 }
      })
    },
    launchAccountHome: async () => NEXT,
    usageLimitAutoContinue: {
      accountUsage: async () => ({
        scope: NEXT.path,
        account: { key: NEXT.path, read: () => exhausted, refresh: () => false }
      })
    }
  } as unknown as Parameters<UsageLimitAccountHolds['attribute']>[1]
  await holds.attribute('chat', host, CUT, SWITCHED)
  const cut = { ...holds.withSwitchReset('chat', CUT), resetsAt: SWITCHED }
  expect(holds.ready('chat', cut, SWITCHED + 135_000)).toBe(false)
})

it('does not let later spending revive an expired moved cut', async () => {
  const overdue = SWITCHED + NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS + 5_000
  const holds = await attributed(NEXT, {
    ...reading({ usedPercent: 100, resetsAt: overdue + 3_600_000 }),
    updatedAt: overdue
  })
  const cut = holds.withSwitchReset('chat', CUT)
  expect(holds.schedulable('chat', cut, overdue)).toBe(false)
})

it('releases a moved chat from picker room that arrived after its turn before the sweep', async () => {
  const room = {
    ...reading({ usedPercent: 0, resetsAt: SWITCHED + 3_600_000 }),
    updatedAt: ENDED + 1
  }
  const holds = await attributed(NEXT, room)
  const cut = { ...holds.withSwitchReset('chat', CUT), resetsAt: SWITCHED }
  expect(holds.verdict('chat', cut, SWITCHED).resetsAt).toBe(ENDED + 1)
  expect(holds.ready('chat', cut, SWITCHED)).toBe(true)
})

it('does not release a moved chat from room that predates its turn', async () => {
  const room = {
    ...reading({ usedPercent: 0, resetsAt: SWITCHED + 3_600_000 }),
    updatedAt: ENDED - 1
  }
  const holds = await attributed(NEXT, room)
  const cut = { ...holds.withSwitchReset('chat', CUT), resetsAt: SWITCHED }
  expect(holds.verdict('chat', cut, SWITCHED).resetsAt).toBe(SWITCHED)
  expect(holds.ready('chat', cut, SWITCHED)).toBe(false)
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

it('asks once for 100 resetless relaunched chats on the same account', async () => {
  const holds = new UsageLimitAccountHolds()
  let asked = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution reads only these fields
  const host = {
    store: {
      getRecord: () => ({
        provider: 'codex',
        location: { wslDistro: null },
        launchedAccount: { fence: 4, accountHome: NEXT },
        lease: { runtimeFence: 4 }
      })
    },
    launchAccountHome: async () => NEXT,
    usageLimitAutoContinue: {
      accountUsage: async () => ({
        scope: 'shared-account',
        bootstrap: () => (++asked, true)
      })
    }
  } as unknown as Parameters<UsageLimitAccountHolds['attribute']>[1]
  for (let index = 0; index < 100; index += 1) {
    const id = `chat-${index}`
    await holds.attribute(id, host, CUT, SWITCHED)
    holds.askForRelaunchRoom(id, holds.withSwitchReset(id, CUT))
  }
  expect(asked).toBe(1)
})

it('retries a refused resetless relaunch read until it is accepted', async () => {
  const holds = new UsageLimitAccountHolds()
  let asked = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution reads only these fields
  const host = {
    store: {
      getRecord: () => ({
        provider: 'codex',
        location: { wslDistro: null },
        launchedAccount: { fence: 4, accountHome: NEXT },
        lease: { runtimeFence: 4 }
      })
    },
    launchAccountHome: async () => NEXT,
    usageLimitAutoContinue: {
      accountUsage: async () => ({
        scope: 'retry-account',
        bootstrap: () => ++asked > 1
      })
    }
  } as unknown as Parameters<UsageLimitAccountHolds['attribute']>[1]
  await holds.attribute('chat', host, CUT, SWITCHED)
  const cut = holds.withSwitchReset('chat', CUT)
  holds.askForRelaunchRoom('chat', cut)
  holds.askForRelaunchRoom('chat', cut)
  holds.askForRelaunchRoom('chat', cut)
  expect(asked).toBe(2)
})

it('uses an existing account selection reading without starting another read', async () => {
  const holds = new UsageLimitAccountHolds()
  let asked = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution reads only these fields
  const host = {
    store: {
      getRecord: () => ({
        provider: 'codex',
        location: { wslDistro: null },
        launchedAccount: { fence: 4, accountHome: NEXT },
        lease: { runtimeFence: 4 }
      })
    },
    launchAccountHome: async () => NEXT,
    usageLimitAutoContinue: {
      accountUsage: async () => ({
        scope: 'selected-account',
        account: {
          key: 'selected-account',
          read: () => reading({ usedPercent: 0, resetsAt: SWITCHED }),
          refresh: () => (++asked, true)
        }
      })
    }
  } as unknown as Parameters<UsageLimitAccountHolds['attribute']>[1]
  await holds.attribute('chat', host, CUT, SWITCHED)
  holds.askForRelaunchRoom('chat', holds.withSwitchReset('chat', CUT), SWITCHED + 5_000)
  expect(asked).toBe(0)
})

it('holds a relaunched cut with a known reset on spending read before that reset', async () => {
  const resetsAt = SWITCHED + 60_000
  const spentUntil = resetsAt + 3_600_000
  const holds = new UsageLimitAccountHolds()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution reads only these fields
  const host = {
    store: {
      getRecord: () => ({
        provider: 'codex',
        location: { wslDistro: null },
        launchedAccount: { fence: 4, accountHome: NEXT },
        lease: { runtimeFence: 4 }
      })
    },
    launchAccountHome: async () => NEXT,
    usageLimitAutoContinue: {
      accountUsage: async () => ({
        scope: NEXT.path,
        account: {
          key: NEXT.path,
          read: () => reading({ usedPercent: 100, resetsAt: spentUntil }),
          refresh: () => true
        }
      })
    }
  } as unknown as Parameters<UsageLimitAccountHolds['attribute']>[1]
  const cut = { ...CUT, resetsAt }
  await holds.attribute('chat', host, cut, SWITCHED)
  expect(holds.verdict('chat', cut, resetsAt + 200_000).resetsAt).toBe(spentUntil)
  expect(holds.ready('chat', cut, resetsAt + 200_000)).toBe(false)
})

it('releases a relaunched known-reset cut on room read after earlier unknown spending', async () => {
  const resetsAt = SWITCHED + 3_600_000
  let current: ProviderRateLimits = {
    ...reading({ usedPercent: 100, resetsAt }),
    session: { usedPercent: 100, windowMinutes: 300, resetsAt: null, resetDescription: null },
    updatedAt: ENDED - 10_000
  }
  const holds = new UsageLimitAccountHolds()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution reads only these fields
  const host = {
    store: {
      getRecord: () => ({
        provider: 'codex',
        location: { wslDistro: null },
        launchedAccount: { fence: 4, accountHome: NEXT },
        lease: { runtimeFence: 4 }
      })
    },
    launchAccountHome: async () => NEXT,
    usageLimitAutoContinue: {
      accountUsage: async () => ({
        scope: NEXT.path,
        account: { key: NEXT.path, read: () => current, refresh: () => true }
      })
    }
  } as unknown as Parameters<UsageLimitAccountHolds['attribute']>[1]
  const cut = { ...CUT, resetsAt }
  await holds.attribute('chat', host, cut, SWITCHED)
  expect(holds.ready('chat', cut, SWITCHED + 60_000)).toBe(false)
  current = { ...reading({ usedPercent: 10, resetsAt }), updatedAt: SWITCHED + 120_000 }
  expect(holds.verdict('chat', cut, SWITCHED + 130_000)).toMatchObject({
    resetsAt: SWITCHED + 120_000,
    unknownReset: false
  })
  expect(holds.ready('chat', cut, SWITCHED + 140_000)).toBe(true)
})

it('does not let a live-session spent reading strand a relaunched known-reset cut', async () => {
  const resetsAt = SWITCHED + 60_000
  const holds = new UsageLimitAccountHolds()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution reads only these fields
  const host = {
    store: {
      getRecord: () => ({
        provider: 'codex',
        location: { wslDistro: null },
        launchedAccount: { fence: 4, accountHome: NEXT },
        lease: { runtimeFence: 4 }
      })
    },
    launchAccountHome: async () => NEXT,
    usageLimitAutoContinue: {
      accountUsage: async () => ({
        scope: NEXT.path,
        account: {
          key: NEXT.path,
          read: (): ProviderRateLimits => ({
            ...reading({ usedPercent: 100, resetsAt }),
            session: {
              usedPercent: 100,
              windowMinutes: 300,
              resetsAt: null,
              resetDescription: null
            },
            usageMetadata: { source: 'live-session' }
          }),
          refresh: () => false
        }
      })
    }
  } as unknown as Parameters<UsageLimitAccountHolds['attribute']>[1]
  const cut = { ...CUT, resetsAt }
  await holds.attribute('chat', host, cut, SWITCHED)
  expect(holds.verdict('chat', cut, resetsAt + 200_000).unknownReset).toBe(false)
  expect(holds.ready('chat', cut, resetsAt + 200_000)).toBe(true)
})
