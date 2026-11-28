import { expect, it } from 'vitest'
import type { LegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { isOptionalAgentSessionLaunchedAccount } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { UsageLimitAccountHolds } from './structured-agent-session-usage-limit-account-hold'

// agy keeps every saved account in one home; only the record's saved account tells them apart.
const HOME: LegacyAgentSessionAccountHome = { variable: 'GEMINI_HOME', path: '/home/u/.gemini' }
const ENDED = 1_000_000
const RESETS = ENDED + 3 * 3_600_000
const SWITCHED = ENDED + 60_000

function chat(fence: number, launchedOn: string) {
  // The record as it reads back from disk after a restart.
  const launchedAccount: unknown = JSON.parse(
    JSON.stringify({ fence, accountHome: HOME, accountId: launchedOn })
  )
  expect(isOptionalAgentSessionLaunchedAccount(launchedAccount)).toBe(true)
  return {
    provider: 'antigravity',
    location: { wslDistro: null },
    accountHome: HOME,
    launchedAccount,
    lease: { runtimeFence: fence }
  }
}

function host(records: Record<string, ReturnType<typeof chat>>, selected: () => string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution reads only these fields
  return {
    store: { getRecord: (id: string) => records[id] },
    launchAccountHome: async () => null,
    usageLimitAutoContinue: {
      accountWitness: () => selected(),
      launchAccountId: () => selected(),
      accountLabel: (_provider: string, id: string) => `${id}@example.com`
    }
  } as unknown as Parameters<UsageLimitAccountHolds['attribute']>[1]
}

const cut = (turnItemId: string, fence: number, resetsAt = RESETS) => ({
  turnItemId,
  turnEndedAt: ENDED,
  resetsAt,
  fence
})

it('frees a chat at once when another saved account is selected, by the account its record kept', async () => {
  // A fresh hold, as after an Orca restart: only the record says the cut hit `work`.
  const holds = new UsageLimitAccountHolds()
  let selected = 'work'
  const records = { chat: chat(3, 'work') }
  await holds.attribute(
    'chat',
    host(records, () => selected),
    cut('turn-1', 3),
    SWITCHED - 1
  )
  expect(holds.verdict('chat', cut('turn-1', 3), SWITCHED).resetsAt).toBe(RESETS)

  selected = 'personal'
  await holds.attribute(
    'chat',
    host(records, () => selected),
    cut('turn-1', 3),
    SWITCHED
  )
  const verdict = holds.verdict('chat', cut('turn-1', 3), SWITCHED + 1)
  expect(verdict.resetsAt).toBe(SWITCHED)
  expect(verdict.limitedAccount).toBeUndefined()
  expect(holds.ready('chat', cut('turn-1', 3), SWITCHED + 20_000)).toBe(true)
})

it('waits for the account it moved to when that account is known to be out of quota too', async () => {
  const holds = new UsageLimitAccountHolds()
  const personalResets = ENDED + 5 * 3_600_000
  let selected = 'work'
  const records = { chat: chat(3, 'work'), other: chat(7, 'personal') }
  const pass = (now: number) =>
    Promise.all([
      holds.attribute(
        'chat',
        host(records, () => selected),
        cut('turn-1', 3),
        now
      ),
      holds.attribute(
        'other',
        host(records, () => selected),
        cut('turn-9', 7, personalResets),
        now
      )
    ])
  await pass(SWITCHED - 1)

  selected = 'personal'
  await pass(SWITCHED)
  const verdict = holds.verdict('chat', cut('turn-1', 3), SWITCHED + 1)
  expect(verdict.resetsAt).toBe(personalResets)
  expect(verdict.limitedAccount).toBe('personal@example.com')
  expect(holds.ready('chat', cut('turn-1', 3), SWITCHED + 20_000)).toBe(false)
})
