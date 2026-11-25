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

const COMPACTED: AgentJournalItemBody = {
  kind: 'status',
  text: 'Context compacted',
  presentation: 'compaction'
}
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
    continuedOutside: mutations.some(
      (row) => row.kind === 'item' && row.identity.provider === 'legacy'
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

describe('Claude compaction rows on transcript catch-up', () => {
  it('recovers a boundary from unseen work under the live key, without an outside-work divider of its own', async () => {
    const unseen = await catchUp([prompt('u1', null, 1), boundary('b1', 'u1', 2)], [])
    expect(unseen.compactions.map((row) => agentJournalItemKey(row.identity))).toEqual([liveKey])

    const onlyBoundary = await catchUp(
      [prompt('u1', null, 1), boundary('b1', 'u1', 2)],
      [savedRow(promptKey('u1'), { kind: 'message', role: 'user', text: 'Synthetic turn u1' })]
    )
    expect(onlyBoundary.continuedOutside).toBe(false)
  })

  it('adds no second row when the live row already exists', async () => {
    const result = await catchUp(
      [prompt('u1', null, 1), boundary('b1', 'u1', 2)],
      [savedRow(liveKey, COMPACTED)]
    )
    expect(result.compactions).toEqual([])
  })

  it('leaves boundaries inside saved turns or before saved history to the live writer', async () => {
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
    expect(beforeSaved.compactions).toEqual([])
    expect(beforeSaved.keys).not.toContain(liveKey)
  })
})
