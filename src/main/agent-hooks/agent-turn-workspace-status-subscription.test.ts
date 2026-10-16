import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnrichedAgentHookEventPayload } from './server/server-types'
import type { AgentTurnWorkspaceStatusEvent } from './agent-turn-workspace-status-sync'

type Harness = {
  subscriber: ((enriched: EnrichedAgentHookEventPayload) => void) | null
  started: string[]
  ended: string[]
  release: (() => void)[]
}

const harness: Harness = vi.hoisted(() => ({
  subscriber: null,
  started: [],
  ended: [],
  release: []
}))

// Why the mocks: this proves only the subscriber's per-workspace ordering. The hook server's row
// store and the move logic are exercised by the sync and runtime tests, so both are stubbed here.
vi.mock('./server', () => ({
  agentHookServer: {
    subscribeEnrichedStatus: (cb: (enriched: EnrichedAgentHookEventPayload) => void) => {
      harness.subscriber = cb
    }
  }
}))

vi.mock('./agent-turn-workspace-status-runtime', () => ({
  agentTurnWorkspaceStatusDeps: () => ({
    isEnabled: () => true,
    getWorkspaceStatuses: () => [],
    resolveWorktreeIdForTab: (tabId: string) => `wt:${tabId}`,
    getWorkspaceStatus: () => 'in-progress',
    getLivePanes: () => [],
    setWorkspaceStatus: async () => {}
  })
}))

vi.mock('./agent-turn-workspace-status-sync', () => ({
  maybeSyncWorkspaceStatusOnAgentTurn: (event: AgentTurnWorkspaceStatusEvent) => {
    const key = event.tabId ? `wt:${event.tabId}` : (event.worktreeId ?? 'unknown')
    harness.started.push(key)
    return new Promise<void>((resolve) => {
      harness.release.push(() => {
        harness.ended.push(key)
        resolve()
      })
    })
  }
}))

import { subscribeWorkspaceStatusToAgentTurns } from './agent-turn-workspace-status-subscription'

type SubscribeArgs = Parameters<typeof subscribeWorkspaceStatusToAgentTurns>
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime deps mock ignores both arguments; ordering never reads them.
const store = {} as SubscribeArgs[0]
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same; the deps mock ignores this argument too.
const runtime = {} as SubscribeArgs[1]

function enriched(
  tabId: string | undefined,
  worktreeId: string | undefined
): EnrichedAgentHookEventPayload {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: turnEventOf reads only these fields; the rest of the wire row is irrelevant to ordering.
  return {
    paneKey: `${tabId ?? worktreeId ?? 'p'}:0`,
    tabId,
    worktreeId,
    payload: { state: 'working' }
  } as EnrichedAgentHookEventPayload
}

// A macrotask tick drains every queued microtask hop the promise chain adds, without touching the
// manually-released move promises.
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  harness.subscriber = null
  harness.started = []
  harness.ended = []
  harness.release = []
  subscribeWorkspaceStatusToAgentTurns(store, runtime)
})

describe('subscribeWorkspaceStatusToAgentTurns', () => {
  it('runs two boundaries for one workspace one after the other', async () => {
    harness.subscriber?.(enriched('t1', 'echo'))
    await settle()
    expect(harness.started).toEqual(['wt:t1'])

    harness.subscriber?.(enriched('t1', 'echo'))
    await settle()
    // The second move stays queued until the first write settles, so it re-reads the committed column.
    expect(harness.started).toEqual(['wt:t1'])

    harness.release[0]?.()
    await settle()
    expect(harness.started).toEqual(['wt:t1', 'wt:t1'])
    expect(harness.ended).toEqual(['wt:t1'])

    harness.release[1]?.()
    await settle()
    expect(harness.ended).toEqual(['wt:t1', 'wt:t1'])
  })

  it('runs different workspaces concurrently', async () => {
    harness.subscriber?.(enriched('tA', undefined))
    harness.subscriber?.(enriched('tB', undefined))
    await settle()
    expect(harness.started).toEqual(['wt:tA', 'wt:tB'])
    expect(harness.ended).toEqual([])
  })

  it('calls through directly when no workspace resolves', async () => {
    harness.subscriber?.(enriched(undefined, undefined))
    await settle()
    expect(harness.started).toEqual(['unknown'])
  })
})
