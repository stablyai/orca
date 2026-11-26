// Perf contract for #47783: chats waiting on unreachable daemon starts share one retry timer and
// one 5 min cadence, and no timer is left once no chat waits (per-start or per-chat timers, per-start
// cadences, or a timer kept after the last close fail it).
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import {
  beginProviderRelayRunAsk,
  noteProviderRelayRunVerdict
} from '../../../provider-relay/provider-relay-launch-inventory'
import type { ProviderRelayRunRecord } from '../../../provider-relay/app-provider-relays'
import type { StructuredAgentSessionHostSession } from '../host/structured-agent-session-host-types'
import { StructuredAgentSessionKeptOpens } from './structured-agent-session-kept-open-reconciler'
import { readProcessStartTimeMs } from '../../../runtime/agent-session/ownership/agent-session-process-identity-probe'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function waitingChats(chats: number, starts: number) {
  const records = new Map<string, ProviderRelayRunRecord>()
  const sessions = new Map<string, StructuredAgentSessionHostSession>()
  for (let i = 0; i < chats; i += 1) {
    const sessionId = `chat-${i}`
    records.set(sessionId, {
      sessionId,
      provider: 'codex',
      location: { executionHostId: LOCAL_EXECUTION_HOST_ID },
      lastRunPlacement: {
        fence: 1,
        kind: 'relayed',
        relayId: `relay-${i}`,
        daemon: { instance: `start-${i % starts}`, pid: 100 + (i % starts), startedAtMs: 1 },
        agent: { hostId: 'host', pid: 1000 + i, processStartTimeMs: 1, spawnToken: `t-${i}` }
      }
    })
    const open = { child: null, journal: { cursor: () => ({ sequence: 0 }) } }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reconciler reads only the journal cursor and child of an open session.
    sessions.set(sessionId, open as unknown as StructuredAgentSessionHostSession)
    noteProviderRelayRunVerdict(sessionId, beginProviderRelayRunAsk(sessionId), 'unknown')
  }
  return { records, sessions }
}

it('keeps one retry timer for every waiting chat on every unreachable start, and none once none waits', () => {
  for (const [chats, starts] of [
    [10, 2],
    [100, 20]
  ]) {
    const { records, sessions } = waitingChats(chats, starts)
    const keptOpens = new StructuredAgentSessionKeptOpens({
      sessions,
      serialize: (_id, task) => task(),
      trackStart: (start) => start,
      record: (id) => records.get(id) ?? null,
      fence: () => 1,
      settle: async () => {},
      logger: { warn: () => {} }
    })
    expect(vi.getTimerCount()).toBe(0)

    for (const [id, session] of sessions) {
      keptOpens.adopted(id, session)
    }
    expect(vi.getTimerCount()).toBe(1)

    for (const id of sessions.keys()) {
      keptOpens.closed(id)
    }
    expect(vi.getTimerCount()).toBe(0)
    keptOpens.dispose()
  }
})

it.skipIf(process.platform === 'win32')(
  'wakes on one shared 5 min cadence however many starts wait and whenever each began',
  async () => {
    const realStartMs = await readProcessStartTimeMs(process.pid)
    const settle = async () => {
      for (let i = 0; i < 16; i += 1) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    // A fixed epoch, so the shared cadence's grid falls the same way on every run.
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    vi.resetModules()
    const relays = await import('../../../provider-relay/app-provider-relays')
    const inventory = await import('../../../provider-relay/provider-relay-launch-inventory')
    const { StructuredAgentSessionKeptOpens: KeptOpens } =
      await import('./structured-agent-session-kept-open-reconciler')
    relays.registerReattachableProviderRelayAgent('codex-test', { provider: 'codex' })
    // No daemon start answers, and each one's daemon (this process) is alive: every ask stays unknown.
    relays.installProviderRelayRoute({
      current: async () => null,
      all: async () => [],
      appVersion: 'test',
      idleStopMs: () => null
    })
    const starts = 20
    const asks: { at: number; id: string }[] = []
    const records = new Map<string, ProviderRelayRunRecord>()
    const sessions = new Map<string, StructuredAgentSessionHostSession>()
    const keptOpens = new KeptOpens({
      sessions,
      serialize: (_id, task) => task(),
      trackStart: (start) => start,
      record: (id) => {
        asks.push({ at: Date.now(), id })
        return records.get(id) ?? null
      },
      fence: () => 1,
      settle: async () => {},
      logger: { warn: () => {} }
    })
    for (let i = 0; i < starts; i += 1) {
      const sessionId = `staggered-${i}`
      records.set(sessionId, {
        sessionId,
        provider: 'codex',
        location: { executionHostId: LOCAL_EXECUTION_HOST_ID },
        lastRunPlacement: {
          fence: 1,
          kind: 'relayed',
          relayId: `relay-${i}`,
          daemon: { instance: `start-${i}`, pid: process.pid, startedAtMs: realStartMs ?? 1 },
          agent: { hostId: 'host', pid: process.pid, processStartTimeMs: 1, spawnToken: `t-${i}` }
        }
      })
      const open = { child: null, journal: { cursor: () => ({ sequence: 0 }) } }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reconciler reads only the journal cursor and child of an open session.
      sessions.set(sessionId, open as unknown as StructuredAgentSessionHostSession)
      inventory.noteProviderRelayRunVerdict(
        sessionId,
        inventory.beginProviderRelayRunAsk(sessionId),
        'unknown'
      )
      keptOpens.adopted(sessionId, sessions.get(sessionId)!)
      // Each start begins waiting 37 s after the last, so their backoffs never line up on their own.
      for (let s = 0; s < 37; s += 1) {
        await vi.advanceTimersByTimeAsync(1_000)
        await settle()
      }
    }
    asks.length = 0
    const hourFrom = Date.now() + 60 * 60_000
    for (let s = 0; s < 2 * 60 * 60; s += 5) {
      await vi.advanceTimersByTimeAsync(5_000)
      await settle()
    }
    const inLastHour = asks.filter(({ at }) => at >= hourFrom)
    const lastHour = new Set(inLastHour.map(({ at }) => at))
    // Every waiting start is still asked.
    expect(new Set(inLastHour.map(({ id }) => id)).size).toBe(starts)
    // At most one wakeup per 5 min for all twenty starts, not one per start (a start whose probe
    // finishes late under load waits for the next shared tick; it never adds one).
    expect(lastHour.size).toBeGreaterThan(0)
    expect(lastHour.size).toBeLessThanOrEqual(12)
    keptOpens.dispose()
  }
)
