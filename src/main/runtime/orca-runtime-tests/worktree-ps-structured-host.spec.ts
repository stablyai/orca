import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, store } from '../orca-runtime-test-fixtures.spec'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  getStructuredAgentSessionHost,
  setStructuredAgentSessionHost
} from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { StructuredAgentSessionStatusFeed } from '../../native-chat/agent-session-wire/structured-agent-session-status-feed'

/**
 * The production wiring, not the projection. Both structured-row suites call
 * `attachRuntimeWorktreeAgentRows` directly with summaries they built themselves, so nothing
 * executed `getWorktreePs`'s own `getStructuredAgentSessionHost()?.liveSessionStatusSummaries()`
 * — and that file carries `@ts-nocheck`, so renaming the accessor stayed green in typecheck AND
 * in the suite while `orca worktree ps` and mobile's poll would throw for every user.
 */

const HELD_SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const FORGOTTEN_SESSION = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
const OBSERVED_AT = 1_757_030_400_000

function runningTurn(prompt: string): AgentJournalRenderItem[] {
  return [
    {
      itemId: 'user-1',
      sequence: 1,
      revision: 1,
      observedAt: OBSERVED_AT,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: prompt }] }
    },
    {
      itemId: 'turn-1',
      sequence: 2,
      revision: 1,
      observedAt: OBSERVED_AT,
      body: {
        kind: 'status',
        text: 'Working',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      }
    }
  ]
}

function journalWith(prompt: string): AgentSessionJournal {
  return {
    isReadOnly: false,
    lastActivityAt: () => OBSERVED_AT,
    snapshot: () => ({ items: runningTurn(prompt) })
  } as unknown as AgentSessionJournal
}

/** A real feed the host still holds one session on, having forgotten the other. Its `published`
 *  cache never retracts, so the two views genuinely differ. */
function statusFeed(): StructuredAgentSessionStatusFeed {
  const session = (prompt: string) => ({
    journal: journalWith(prompt),
    params: { location: { workspaceId: TEST_WORKTREE_ID }, provider: 'claude' as const }
  })
  const sessions = new Map([
    [HELD_SESSION, session('ship the thing')],
    [FORGOTTEN_SESSION, session('rm the branch')]
  ])
  const feed = new StructuredAgentSessionStatusFeed({
    sessions,
    getRecord: () => null,
    now: () => OBSERVED_AT
  })
  feed.publish(HELD_SESSION)
  feed.publish(FORGOTTEN_SESSION)
  // `forget-session`, the last eviction step, drops the session and leaves the feed alone.
  sessions.delete(FORGOTTEN_SESSION)
  return feed
}

/** Everything the feed retained, read through the snapshot a subscriber opens on. No production
 *  code reads this; it is here so swapping the call site back to a whole-cache read is a one-line
 *  edit that this suite must catch. */
function retainedSummaries(feed: StructuredAgentSessionStatusFeed): AgentSessionStatusSummary[] {
  let retained: AgentSessionStatusSummary[] = []
  feed.subscribe({
    id: 'retained-probe',
    emit: (event: AgentSessionStatusEvent) => {
      if (event.type === 'snapshot') {
        retained = event.sessions
      }
    }
  })()
  return retained
}

function installHost(feed: StructuredAgentSessionStatusFeed) {
  const liveSessionStatusSummaries = vi.fn(() => feed.liveSessionSummaries())
  const retainedSessionStatusSummaries = vi.fn(() => retainedSummaries(feed))
  // Typed against the real host, so renaming the accessor on the class reddens `tc` here — the
  // caller cannot, because `orca-runtime-get-worktree-ps.ts` is `@ts-nocheck`.
  const host: Pick<StructuredAgentSessionHost, 'liveSessionStatusSummaries'> & {
    retainedSessionStatusSummaries: () => AgentSessionStatusSummary[]
  } = { liveSessionStatusSummaries, retainedSessionStatusSummaries }
  setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
  return { liveSessionStatusSummaries, retainedSessionStatusSummaries }
}

describe('worktree ps reads the installed structured host', () => {
  afterEach(() => {
    setStructuredAgentSessionHost(null)
  })

  it('reports the held session and asks the host for its live summaries', async () => {
    const feed = statusFeed()
    const { liveSessionStatusSummaries } = installHost(feed)

    const { worktrees } = await new OrcaRuntimeService(store).getWorktreePs()

    const worktree = worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)
    expect(worktree).toBeDefined()
    // Exactly one: the forgotten session is still in the feed's retained cache, so a call site
    // that enumerated that cache instead would report two.
    expect(worktree?.agents).toHaveLength(1)
    expect(worktree?.agents[0]).toMatchObject({
      state: 'working',
      agentType: 'claude',
      prompt: 'ship the thing'
    })
    // Pins the call site to the live-intersecting accessor, not merely to some accessor.
    expect(liveSessionStatusSummaries).toHaveBeenCalledTimes(1)
  })

  it('succeeds with no structured rows when no host is installed', async () => {
    // Guard the guard: these specs share one module registry, so state the premise.
    expect(getStructuredAgentSessionHost()).toBeNull()

    const { worktrees } = await new OrcaRuntimeService(store).getWorktreePs()

    const worktree = worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)
    expect(worktree).toBeDefined()
    expect(worktree?.agents).toEqual([])
  })
})
