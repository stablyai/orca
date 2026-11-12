import type { AgentSessionJournal } from '../../../../../native-chat/agent-session-journal/journal-store'
import { StructuredAgentSessionStatusFeed } from '../../../../../native-chat/agent-session-wire/observations/structured-agent-session-status-feed'
import { createStructuredAgentSessionLogger } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-logger'

export const STATUS_SESSION = 'session-status'
export const STATUS_ITEMS: ReturnType<AgentSessionJournal['snapshot']>['items'] = [
  {
    itemId: 'user-1',
    sequence: 1,
    revision: 1,
    observedAt: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'write a poem' }] }
  },
  {
    itemId: 'turn-1',
    sequence: 2,
    revision: 1,
    observedAt: 2,
    body: { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } }
  }
]

/** One indexed session over a journal that reads back fixed items; the projection is real. */
export const statusFeed = () =>
  new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions: new Map([
      [
        STATUS_SESSION,
        {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the status feed uses these held rows and provenance reads; the item lookup is checked against the real journal contract.
          journal: {
            cursor: () => ({ epoch: 'epoch-status', sequence: 2 }),
            lastActivityAt: () => 2,
            context: { floor: () => null },
            stopMarks: { latest: () => null, revision: () => 0 },
            snapshot: () => ({ items: STATUS_ITEMS, submissions: [] }),
            statusRead: () => ({ items: STATUS_ITEMS, submissions: [] }),
            inputOrder: {
              inputCount: () => 0,
              inputOrdinal: () => Infinity,
              recoverableSubmissions: () => []
            },
            item: ((itemId) =>
              STATUS_ITEMS.find((item) => item.itemId === itemId) ??
              null) satisfies AgentSessionJournal['item'],
            itemFence: () => undefined,
            runningTurn: () => null
          } as unknown as AgentSessionJournal,
          params: {
            location: {
              executionHostId: 'local',
              wslDistro: null,
              workspaceId: 'workspace-1',
              workspaceKind: 'git-worktree' as const
            },
            provider: 'codex' as const
          }
        }
      ]
    ]),
    getConversation: () => null,
    now: () => 1_000
  })
