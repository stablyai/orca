// Shared setup for the status feed's tests: a throwaway journal directory, the session
// shape the feed indexes, and a subscribed feed whose events the caller can read.
//
// One bed rather than one per file, because a second copy is how two suites start
// disagreeing about what a session looks like to this feed.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import {
  StructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusFeedDeps,
  type StructuredAgentSessionStatusSink
} from './structured-agent-session-status-feed'

export function indexedStatusFeedSession(session: {
  journal: AgentSessionJournal
  hasProviderChild?: boolean
  fence?: number
}) {
  return {
    journal: session.journal,
    fence: session.fence ?? 1,
    ...(session.hasProviderChild !== undefined
      ? { hasProviderChild: session.hasProviderChild }
      : {}),
    params: {
      location: {
        executionHostId: 'local' as const,
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree' as const
      },
      provider: 'codex' as const
    }
  }
}

export type StatusFeedTestSessions = Map<
  string,
  { journal: AgentSessionJournal; hasProviderChild?: boolean; fence?: number }
>

type IndexedStatusFeedSession = ReturnType<typeof indexedStatusFeedSession>

/** A live view of the tests' own session map, indexed on every read. A snapshot taken once
 *  would freeze `hasProviderChild`, which several tests flip after the feed is wired. */
class StatusFeedSessionsView extends Map<string, IndexedStatusFeedSession> {
  constructor(private readonly source: StatusFeedTestSessions) {
    super()
  }

  override get(sessionId: string): IndexedStatusFeedSession | undefined {
    const session = this.source.get(sessionId)
    return session ? indexedStatusFeedSession(session) : undefined
  }

  override *[Symbol.iterator](): MapIterator<[string, IndexedStatusFeedSession]> {
    for (const [sessionId, session] of this.source) {
      yield [sessionId, indexedStatusFeedSession(session)]
    }
  }
}

export function createStatusFeedTestBed(defaultSessionId: string) {
  const journals = createTrackedJournalOpener()
  let root = ''

  return {
    open: async (): Promise<void> => {
      root = await mkdtemp(join(tmpdir(), 'orca-agent-status-feed-'))
    },
    close: async (): Promise<void> => {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    },
    /** `now` is the journal's row clock. Pass one wherever a test reasons about row
     *  timestamps: appends inside a single millisecond otherwise share a `ts`, and a
     *  clock assertion over identical numbers holds however the code behaves. */
    openJournal: async (
      sessionId = defaultSessionId,
      now?: () => number
    ): Promise<AgentSessionJournal> =>
      journals.open({
        identity: {
          sessionId,
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'codex',
          providerHandle: { kind: 'codex', threadId: 'thread-1' }
        },
        now,
        journalDir: join(root, sessionId)
      }),
    feedFor: (
      sessions: StatusFeedTestSessions,
      record: Partial<AgentSessionRecord> | null = null,
      onStatusChanged?: StructuredAgentSessionStatusFeedDeps['onStatusChanged'],
      readBackgroundTasks?: StructuredAgentSessionStatusFeedDeps['readBackgroundTasks'],
      statusSink?: StructuredAgentSessionStatusSink
    ) => {
      let now = 1_000
      const feed = new StructuredAgentSessionStatusFeed({
        ...(onStatusChanged ? { onStatusChanged } : {}),
        ...(statusSink ? { statusSink: () => statusSink } : {}),
        ...(readBackgroundTasks ? { readBackgroundTasks } : {}),
        sessions: new StatusFeedSessionsView(sessions),
        getRecord: () => record as AgentSessionRecord | null,
        now: () => (now += 1)
      })
      const events: AgentSessionStatusEvent[] = []
      const dispose = feed.subscribe({ id: 'list-1', emit: (event) => events.push(event) })
      return { feed, events, dispose }
    }
  }
}
