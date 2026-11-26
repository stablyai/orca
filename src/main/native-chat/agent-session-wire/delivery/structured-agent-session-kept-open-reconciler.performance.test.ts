// Perf contract for #47783: chats waiting on unreachable daemon starts share one retry timer,
// and none is left once no chat waits (per-start or per-chat timers, or a timer kept after the
// last close, fail it).
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import {
  beginProviderRelayRunAsk,
  noteProviderRelayRunVerdict
} from '../../../provider-relay/provider-relay-launch-inventory'
import type { ProviderRelayRunRecord } from '../../../provider-relay/app-provider-relays'
import type { StructuredAgentSessionHostSession } from '../host/structured-agent-session-host-types'
import { StructuredAgentSessionKeptOpens } from './structured-agent-session-kept-open-reconciler'

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
