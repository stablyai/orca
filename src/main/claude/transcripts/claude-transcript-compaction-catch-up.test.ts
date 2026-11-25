import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalHistoryItem } from '../../native-chat/agent-session-journal/journal-history-items'
import { claudeCompactionIdentity } from '../structured/journal/claude-journal-compactions'
import { createClaudeTranscriptImportPlan } from './claude-transcript-import-plan'
import { createClaudeTranscriptItemReader } from './claude-transcript-item-reader'

const SESSION = 'orca-chat'
const PROVIDER = '2abbdce5-4589-40ed-b849-0cec8fcfda83'
const at = (second: number) => `2026-11-25T10:00:${String(second).padStart(2, '0')}.000Z`

const prompt = (uuid: string, parentUuid: string | null, second: number) => ({
  type: 'user',
  uuid,
  parentUuid,
  sessionId: PROVIDER,
  timestamp: at(second),
  message: { role: 'user', content: `Synthetic turn ${uuid}` }
})
const boundary = (uuid: string, logicalParentUuid: string, second: number) => ({
  type: 'system',
  subtype: 'compact_boundary',
  uuid,
  parentUuid: null,
  logicalParentUuid,
  sessionId: PROVIDER,
  timestamp: at(second),
  compactMetadata: { trigger: 'auto', preTokens: 39559 }
})

const promptKey = (uuid: string) =>
  agentJournalItemKey({ provider: 'claude', sessionId: PROVIDER, uuid })
const savedRow = (key: string, body: AgentJournalItemBody): JournalHistoryItem => ({
  key,
  canonicalItemId: key,
  removed: false,
  item: { itemId: key, revision: 1, body, sequence: 1, observedAt: 1 }
})

async function catchUp(rows: Record<string, unknown>[], saved: JournalHistoryItem[]) {
  const byKey = new Map(saved.map((entry) => [entry.key, entry]))
  const items = await createClaudeTranscriptItemReader(
    {
      historyItems: async (keys) => keys.flatMap((key) => byKey.get(key) ?? []),
      claudeHistoryPrompts: async () => []
    },
    SESSION,
    [],
    []
  )
  const plan = createClaudeTranscriptImportPlan({
    sessionId: SESSION,
    providerSessionId: PROVIDER,
    epoch: 'epoch',
    items,
    rewound: false,
    check: () => {}
  })
  for (const row of rows) {
    await items.loadRow(row, PROVIDER)
    await plan.restore(row)
  }
  const result = await plan.finish()
  plan.dispose()
  const mutations = result?.mutations ?? []
  return {
    compactions: mutations.filter(
      (row) =>
        row.kind === 'item' && row.body.kind === 'status' && row.body.presentation === 'compaction'
    ),
    keys: mutations.map((row) => agentJournalItemKey(row.identity))
  }
}

// The live writer keys the row by the stream frame; catch-up must land on that same row.
const liveKey = agentJournalItemKey(
  claudeCompactionIdentity({
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'b1',
    session_id: PROVIDER,
    parent_tool_use_id: null
  })!
)

// Claude Code 2.1.332 manual /compact, captured 2026-11-25: the boundary precedes the command row.
const manualCompact = (parent: string) => [
  {
    ...boundary('b1', parent, 4),
    compactMetadata: { trigger: 'manual', preTokens: 38625 }
  },
  {
    type: 'user',
    uuid: 's1',
    parentUuid: 'b1',
    sessionId: PROVIDER,
    timestamp: at(4),
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    message: {
      role: 'user',
      content: 'This session is being continued from a previous conversation.'
    }
  },
  {
    type: 'user',
    uuid: 'c1',
    parentUuid: 's1',
    sessionId: PROVIDER,
    timestamp: at(3),
    message: {
      role: 'user',
      content:
        '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'
    }
  },
  {
    type: 'user',
    uuid: 'o1',
    parentUuid: 'c1',
    sessionId: PROVIDER,
    timestamp: at(5),
    message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' }
  }
]

describe('Claude compaction rows on transcript catch-up', () => {
  it('recovers an automatic boundary from unseen work under the live key', async () => {
    const unseen = await catchUp([prompt('u1', null, 1), boundary('b1', 'u1', 2)], [])
    expect(unseen.compactions.map((row) => agentJournalItemKey(row.identity))).toEqual([liveKey])
  })

  it('leaves boundaries Orca already showed, or could have, to the live writer', async () => {
    // Older builds saved /compact under the command's own key and no automatic row at all.
    const savedTurn = await catchUp(
      [prompt('u1', null, 1), boundary('b1', 'u1', 2)],
      [savedRow(promptKey('u1'), { kind: 'message', role: 'user', text: 'Synthetic turn u1' })]
    )
    expect(savedTurn.compactions).toEqual([])

    // A recovered divider would otherwise land below the later reply already on screen.
    const beforeSaved = await catchUp(
      [prompt('u1', null, 1), boundary('b1', 'u1', 2), prompt('u2', 'b1', 3)],
      [savedRow(promptKey('u2'), { kind: 'message', role: 'user', text: 'Synthetic turn u2' })]
    )
    expect(beforeSaved.keys).not.toContain(liveKey)

    // Orca's /compact wrote its own row live, which catch-up cannot see before the command row.
    const manual = await catchUp([prompt('u1', null, 1), ...manualCompact('u1')], [])
    expect(manual.compactions).toEqual([])
  })
})
