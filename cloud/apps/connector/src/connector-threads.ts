import type { CloudDatabase, SqlRow } from '@orca-cloud/cloud-database'
import {
  ConnectorConversationSchema,
  type ConnectorConversation,
  type ConnectorEvent
} from '@orca-cloud/connector-contract'
import type { ThreadPlace } from './connector-adapter.js'

// Linked and snapshot (re)bind a conversation's pane. Moving to another pane forgets the old pane's
// turn and its verdict; one it left open (working or unverifiable) stays unverifiable, never done.
const REBIND_PANE = `pane_key = ?,
  open_turn_id = CASE WHEN pane_key = ? THEN open_turn_id END,
  turn_state = CASE WHEN pane_key IS NULL OR pane_key = ? THEN turn_state
    WHEN turn_state IN ('working', 'unverifiable') THEN 'unverifiable' END,
  turn_stop_reason = CASE WHEN pane_key IS NULL OR pane_key = ? THEN turn_stop_reason END`
const rebindParams = (paneKey: string) => [paneKey, paneKey, paneKey, paneKey]
// Other events only touch the pane the conversation is bound to.
const ON_BOUND_PANE =
  'host_id = ? AND source = ? AND external_id = ? AND (pane_key IS NULL OR pane_key = ?)'

// The (source, external_id) key columns, as query parameters.
export const conversationKey = (conversation: ConnectorConversation) => [
  conversation.source,
  conversation.externalId
]

// A row's conversation, read back from its (source, external_id) columns.
export const conversationOf = (row: SqlRow): ConnectorConversation =>
  ConnectorConversationSchema.parse({ source: row.source, externalId: row.external_id })

// A connector_threads row's place in its source.
export const threadPlace = (thread: SqlRow): ThreadPlace => ({
  workspaceId: String(thread.workspace_id),
  containerId: String(thread.container_id),
  threadId: String(thread.thread_id)
})

export type NewThread = {
  conversation: ConnectorConversation
  place: ThreadPlace
  ownerUserId: string
  accountId: string
  hostId: string
  placeId: string
}

// Each thread is bound to one host for life; events only ever touch that host's threads.
export class ConnectorThreads {
  constructor(private readonly now: () => number) {}

  // Binds the thread to its host on first sight; false when it already belongs to another host.
  async bind(transaction: CloudDatabase, thread: NewThread): Promise<boolean> {
    await transaction.query(
      `INSERT INTO connector_threads
       (source, external_id, workspace_id, container_id, thread_id, owner_user_id, account_id,
        host_id, place_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, external_id) DO NOTHING`,
      [
        ...conversationKey(thread.conversation),
        thread.place.workspaceId,
        thread.place.containerId,
        thread.place.threadId,
        thread.ownerUserId,
        thread.accountId,
        thread.hostId,
        thread.placeId,
        this.now()
      ]
    )
    const [row] = await transaction.query(
      'SELECT host_id FROM connector_threads WHERE source = ? AND external_id = ?',
      conversationKey(thread.conversation)
    )
    return row?.host_id === thread.hostId
  }

  // Idempotent by each event's identity: a resend writes the same state again or matches nothing.
  async applyEvents(
    transaction: CloudDatabase,
    hostId: string,
    events: ConnectorEvent[]
  ): Promise<void> {
    for (const event of events) {
      if (event.kind === 'snapshot') {
        // Not working never means done: an open turn the snapshot doesn't show working (or doesn't
        // list; it lists recently active linked conversations) is unverifiable, and an unlisted one has no prompt.
        const notIn = (conversations: ConnectorConversation[]) =>
          conversations.length > 0
            ? ` AND (source, external_id) NOT IN (VALUES ${conversations.map(() => '(?, ?)').join(', ')})`
            : ''
        const working = event.conversations
          .filter((entry) => entry.working)
          .map((entry) => entry.conversation)
        await transaction.query(
          `UPDATE connector_threads SET turn_state = 'unverifiable'
           WHERE host_id = ? AND turn_state = 'working'${notIn(working)}`,
          [hostId, ...working.flatMap(conversationKey)]
        )
        const listed = event.conversations.map((entry) => entry.conversation)
        await transaction.query(
          `UPDATE connector_threads SET pending_prompt = NULL WHERE host_id = ?${notIn(listed)}`,
          [hostId, ...listed.flatMap(conversationKey)]
        )
        for (const entry of event.conversations) {
          await transaction.query(
            `UPDATE connector_threads SET ${REBIND_PANE}, agent = ?, pending_prompt = ?
             WHERE host_id = ? AND source = ? AND external_id = ?`,
            [
              ...rebindParams(entry.paneKey),
              entry.agent,
              entry.prompt ? JSON.stringify(entry.prompt) : null,
              hostId,
              ...conversationKey(entry.conversation)
            ]
          )
          // A newer turn than the cloud knows: older starts and ends still queued behind this snapshot
          // then change nothing. Its own end, if it ended, follows and settles it. The same turn seen
          // working again (say, an answered approval) is working, but an ended turn never reopens.
          if (entry.turnId !== undefined) {
            const resumed = entry.working
              ? " OR (open_turn_id = ? AND turn_state = 'unverifiable')"
              : ''
            await transaction.query(
              `UPDATE connector_threads SET open_turn_id = ?, turn_state = ?, turn_stop_reason = NULL
               WHERE ${ON_BOUND_PANE} AND (open_turn_id IS NULL OR open_turn_id < ?${resumed})`,
              [
                entry.turnId,
                entry.working ? 'working' : 'unverifiable',
                hostId,
                ...conversationKey(entry.conversation),
                entry.paneKey,
                entry.turnId,
                ...(entry.working ? [entry.turnId] : [])
              ]
            )
          }
        }
        continue
      }
      const where = [hostId, ...conversationKey(event.conversation)]
      const onPane = [...where, event.paneKey]
      switch (event.kind) {
        case 'linked':
          await transaction.query(
            `UPDATE connector_threads SET ${REBIND_PANE}, agent = ?,
               pending_prompt = CASE WHEN pane_key = ? THEN pending_prompt END
             WHERE host_id = ? AND source = ? AND external_id = ?`,
            [...rebindParams(event.paneKey), event.agent, event.paneKey, ...where]
          )
          break
        case 'prompt':
          await transaction.query(
            `UPDATE connector_threads SET pane_key = ?, pending_prompt = ? WHERE ${ON_BOUND_PANE}`,
            [event.paneKey, JSON.stringify(event.prompt), ...onPane]
          )
          break
        case 'turn-started':
          await transaction.query(
            `UPDATE connector_threads SET pane_key = ?, open_turn_id = ?, turn_state = 'working',
               turn_stop_reason = NULL, pending_prompt = NULL
             WHERE ${ON_BOUND_PANE} AND (open_turn_id IS NULL OR open_turn_id < ?)`,
            [event.paneKey, event.at, ...onPane, event.at]
          )
          break
        case 'turn-ended':
          await transaction.query(
            `UPDATE connector_threads SET pane_key = ?, open_turn_id = ?, turn_state = 'ended',
               turn_stop_reason = ?, pending_prompt = NULL
             WHERE ${ON_BOUND_PANE} AND (open_turn_id IS NULL OR open_turn_id <= ?)`,
            [event.paneKey, event.turnId, event.stopReason, ...onPane, event.turnId]
          )
          break
      }
    }
  }
}
