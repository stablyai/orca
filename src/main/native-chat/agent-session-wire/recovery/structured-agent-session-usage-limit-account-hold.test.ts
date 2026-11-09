import { describe, expect, it } from 'vitest'
import type { NativeChatUsageLimitCut } from '../../../../shared/native-chat/native-chat-usage-limit-cut'
import type { UsageLimitAccountReading } from '../../../rate-limits/usage-limit-account-reading'
import { StructuredAgentSessionUsageLimitContinue } from './structured-agent-session-usage-limit-continue'
import { hostTestRestingOptionsRecord } from '../host/testing/structured-agent-session-host-test-data'

const MINUTE = 60_000
const ENDED = 1_000_000
const RESET = ENDED + 60 * MINUTE

function createRig(ids: string[]) {
  let now = ENDED
  let reading: UsageLimitAccountReading | null = {
    checkedAt: ENDED,
    exhausted: true,
    resetsAt: RESET
  }
  const cuts = new Map<string, NativeChatUsageLimitCut | null>(
    ids.map((id) => [id, { turnItemId: `turn-${id}`, resetsAt: RESET, turnEndedAt: ENDED }])
  )
  const sent: string[] = []
  let refreshes = 0
  const record = { ...hostTestRestingOptionsRecord(), provider: 'claude' }
  const scheduler = new StructuredAgentSessionUsageLimitContinue({
    host: {
      logger: { warn: () => {}, error: () => {} },
      usageLimitAutoContinue: {
        isEnabled: () => true,
        subscribe: () => () => {},
        isWorkspaceAsleep: () => false,
        readAccountUsage: () => reading,
        refreshAccountUsage: () => {
          refreshes += 1
        }
      },
      store: {
        listVisibleSessionIds: () => ids,
        getRecord: () => record,
        hostId: record.location.executionHostId,
        isSessionTabVisible: () => true,
        cancelUsageLimitContinue: async () => record
      }
    },
    sessions: new Map(ids.map((id) => [id, {}])),
    readSavedCut: () => null,
    readLoadedCut: (id) => cuts.get(id) ?? null,
    serialize: (_id, run) => run(),
    send: async (params) => {
      const id = params.envelope.sessionId
      sent.push(id)
      // A sent continuation leaves no cut until its turn ends.
      cuts.set(id, null)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scheduler reads only `ok` from a successful send.
      return { ok: true } as never
    },
    publish: () => {},
    now: () => now
  })
  return {
    scheduler,
    sent,
    cuts,
    refreshes: () => refreshes,
    setNow: (at: number) => {
      now = at
    },
    setReading: (next: UsageLimitAccountReading | null) => {
      reading = next
    }
  }
}

describe('usage-limit automatic continue gated by account usage', () => {
  it('waits for a fresh reading after the reset, then resumes every chat on the account in one sweep', async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `chat-${index}`)
    const rig = createRig(ids)

    rig.setNow(RESET + 20_000)
    await rig.scheduler.tick()
    // The last reading predates the reset, so Orca asks once instead of sending into the limit.
    expect(rig.sent).toEqual([])
    expect(rig.refreshes()).toBe(1)

    rig.setReading({ checkedAt: RESET + 25_000, exhausted: false, resetsAt: null })
    rig.setNow(RESET + 30_000)
    await rig.scheduler.tick()
    expect(rig.sent.sort()).toEqual([...ids].sort())
  })

  it('holds past the agent-reported reset while the account says the limit still lasts', async () => {
    const rig = createRig(['chat'])
    const weeklyReset = RESET + 24 * 60 * MINUTE
    rig.setReading({ checkedAt: RESET + 20_000, exhausted: true, resetsAt: weeklyReset })
    rig.setNow(RESET + 30_000)
    await rig.scheduler.tick()
    expect(rig.sent).toEqual([])
    expect(rig.refreshes()).toBe(0)
    expect(rig.scheduler.readState('chat')).toMatchObject({
      state: 'scheduled',
      continueAt: weeklyReset
    })
  })

  it('stops after continuations keep hitting the limit at once instead of filling the chat with errors', async () => {
    const rig = createRig(['chat'])
    // No usable reading: the agent's own reset time is all Orca has.
    rig.setReading(null)
    let now = RESET + 20_000
    for (let round = 0; round < 6; round += 1) {
      rig.setNow(now)
      await rig.scheduler.tick()
      if (rig.cuts.get('chat') === null) {
        // The continuation fails at once, and the agent again claims a reset a minute away.
        rig.cuts.set('chat', {
          turnItemId: `refail-${round}`,
          resetsAt: now + 5_000 + MINUTE,
          turnEndedAt: now + 5_000
        })
      }
      now += 6 * 60 * MINUTE
    }
    expect(rig.sent).toHaveLength(3)
    expect(rig.scheduler.readState('chat')?.state).toBe('failed')
  })
})
