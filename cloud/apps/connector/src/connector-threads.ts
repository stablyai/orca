import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { ConnectorEvent } from '@orca-cloud/connector-contract'

// Linked and snapshot (re)bind a conversation's pane. Moving to another pane forgets the old pane's
// turn and its verdict; one it left open (working or unverifiable) stays unverifiable, never done.
const REBIND_PANE = `pane_key = ?,
  open_turn_id = CASE WHEN pane_key = ? THEN open_turn_id END,
  turn_state = CASE WHEN pane_key IS NULL OR pane_key = ? THEN turn_state
    WHEN turn_state IN ('working', 'unverifiable') THEN 'unverifiable' END,
  turn_stop_reason = CASE WHEN pane_key IS NULL OR pane_key = ? THEN turn_stop_reason END`
const rebindParams = (paneKey: string) => [paneKey, paneKey, paneKey, paneKey]
// Other events only touch the pane the conversation is bound to.
const ON_BOUND_PANE = 'host_id = ? AND external_id = ? AND (pane_key IS NULL OR pane_key = ?)'

export type NewThread = {
  externalId: string
  teamId: string
  channelId: string
  threadTs: string
  ownerUserId: string
  accountId: string
  hostId: string
  placeId: string
}

// Each Slack thread is bound to one host for life; events only ever touch that host's threads.
export class ConnectorThreads {
  constructor(private readonly now: () => number) {}

  // Binds the thread to its host on first sight; false when it already belongs to another host.
  async bind(transaction: CloudDatabase, thread: NewThread): Promise<boolean> {
    await transaction.query(
      `INSERT INTO connector_threads
       (external_id, team_id, channel_id, thread_ts, owner_user_id, account_id, host_id, place_id,
        created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (external_id) DO NOTHING`,
      [
        thread.externalId,
        thread.teamId,
        thread.channelId,
        thread.threadTs,
        thread.ownerUserId,
        thread.accountId,
        thread.hostId,
        thread.placeId,
        this.now()
      ]
    )
    const [row] = await transaction.query(
      'SELECT host_id FROM connector_threads WHERE external_id = ?',
      [thread.externalId]
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
        // list; it lists every linked conversation) is unverifiable, and an unlisted one has no prompt.
        const notIn = (ids: string[]) =>
          ids.length > 0 ? ` AND external_id NOT IN (${ids.map(() => '?').join(', ')})` : ''
        const working = event.conversations
          .filter((entry) => entry.working)
          .map((entry) => entry.conversation.externalId)
        await transaction.query(
          `UPDATE connector_threads SET turn_state = 'unverifiable'
           WHERE host_id = ? AND turn_state = 'working'${notIn(working)}`,
          [hostId, ...working]
        )
        const listed = event.conversations.map((entry) => entry.conversation.externalId)
        await transaction.query(
          `UPDATE connector_threads SET pending_prompt = NULL WHERE host_id = ?${notIn(listed)}`,
          [hostId, ...listed]
        )
        for (const entry of event.conversations) {
          await transaction.query(
            `UPDATE connector_threads SET ${REBIND_PANE}, agent = ?, pending_prompt = ?
             WHERE host_id = ? AND external_id = ?`,
            [
              ...rebindParams(entry.paneKey),
              entry.agent,
              entry.prompt ? JSON.stringify(entry.prompt) : null,
              hostId,
              entry.conversation.externalId
            ]
          )
        }
        continue
      }
      const where = [hostId, event.conversation.externalId]
      const onPane = [...where, event.paneKey]
      switch (event.kind) {
        case 'linked':
          await transaction.query(
            `UPDATE connector_threads SET ${REBIND_PANE}, agent = ?,
               pending_prompt = CASE WHEN pane_key = ? THEN pending_prompt END
             WHERE host_id = ? AND external_id = ?`,
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
            [
              event.paneKey,
              event.turnId,
              event.stopReason,
              ...onPane,
              event.turnId
            ]
          )
          break
      }
    }
  }
}
