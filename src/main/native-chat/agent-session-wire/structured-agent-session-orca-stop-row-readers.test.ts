// The row about Orca's own stop, as each kind of client reads it. A client that predates the cause
// prints the stored row, red and on screen; this build names the cause, muted, and never folds it.

import { describe, expect, it } from 'vitest'
import { agentSessionResponseInterruptedStoredBody } from '../../../shared/agent-session-host-status-rows'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { withNativeChatCutTurnNotices } from '../../../shared/native-chat-cut-turn-notice'
import { latestNativeChatOrcaStopCut } from '../../../shared/native-chat-orca-stop-cut'
import { nativeChatTurnFold } from '../../../shared/native-chat-turn-fold'
import { orcaStopRowBody } from './structured-agent-session-orca-stop-row'

const INTERRUPTED_TEXT = 'This response was interrupted. You can continue in this conversation.'
const TURN = agentJournalItemKey({ provider: 'codex', threadId: 't', turnId: 'cut', ordinal: 1 })

function cutChat(row: AgentJournalRenderItem['body']): AgentJournalRenderItem[] {
  const scope = { kind: 'turn' as const, turnItemId: TURN }
  return [
    {
      itemId: agentJournalItemKey({ provider: 'orca', clientMessageId: 'user-1' }),
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }
    },
    {
      itemId: TURN,
      revision: 2,
      sequence: 2,
      observedAt: 2,
      body: { kind: 'turn', turnId: 'cut', state: 'interrupted', startedAt: 1, completedAt: 5 }
    },
    {
      itemId: agentJournalItemKey({ provider: 'codex', threadId: 't', turnId: 'cut', ordinal: 2 }),
      revision: 1,
      sequence: 3,
      observedAt: 3,
      turnScope: scope,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Looking.' }] }
    },
    {
      itemId: agentJournalItemKey({
        provider: 'orca',
        clientMessageId: 'stale-session:session-1:shutdown-3-gen-1'
      }),
      revision: 1,
      sequence: 4,
      observedAt: 6,
      turnScope: scope,
      body: row
    }
  ]
}

describe('the row a host writes for a cut it knows the cause of', () => {
  const row = orcaStopRowBody('update')

  it('blames no one, stays red, and names its presentation and cause', () => {
    expect(row).toMatchObject({
      kind: 'status',
      text: INTERRUPTED_TEXT,
      tone: 'error',
      presentation: 'orca-stop',
      orcaStop: { cause: 'update' }
    })
    expect(row).not.toHaveProperty('failure')
  })

  it('reads, on a client that predates the cause, as the one row it prints, on screen', () => {
    // That client derives no row of its own beside a host's stale-session row.
    const items = cutChat(row)
    expect(items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))).toEqual([
      INTERRUPTED_TEXT
    ])
    // That client's fold reads only the stored tone: a red row is the turn's end, never folded.
    const rows = items.map((item) => ({
      turnKey: item.itemId === items[0]!.itemId ? undefined : TURN,
      role: item.body.kind === 'message' ? item.body.role : ('system' as const),
      rendersProse: item.body.kind !== 'turn',
      draws: true,
      outlivesTurn: false,
      reportsFailure: item.body.kind === 'status' && item.body.tone === 'error',
      explainsTurn: false
    }))
    const { foldedRows } = nativeChatTurnFold({
      rows,
      settledTurnKeys: new Set([TURN]),
      expandedTurnKeys: new Set()
    })
    expect(foldedRows.has(3)).toBe(false)
  })

  it('reads, on this build, as one muted row that keeps its cause', () => {
    const read = withNativeChatCutTurnNotices(cutChat(row))
    const statusRows = read.filter((item) => item.body.kind === 'status')
    expect(statusRows).toHaveLength(1)
    expect(statusRows[0]!.body).toMatchObject({
      tone: 'notice',
      presentation: 'orca-stop',
      orcaStop: { cause: 'update' }
    })
  })

  it('offers Continue on this build', () => {
    expect(latestNativeChatOrcaStopCut(cutChat(row), [])).toEqual({
      turnItemId: TURN,
      cause: 'update'
    })
  })

  it('is the row for any owner death when the cause is unknown', () => {
    expect(orcaStopRowBody(undefined)).toEqual(agentSessionResponseInterruptedStoredBody())
  })
})
