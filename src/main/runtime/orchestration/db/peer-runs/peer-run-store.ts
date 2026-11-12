import type { RemoteOwnedPeerRun } from '../../../../../shared/orchestration/remote-owned-wire'
import { OrchestrationError } from '../../orchestration-error'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'
import { peerRunDispatchStateStatements } from './peer-run-queue-sql'
import { peerCoordinatorAddress } from '../../addressing/orchestration-caller-identity'

export type PeerRunRow = {
  run_id: string
  conversation_id: string
  peer_fingerprint: string
  home_run_id: string
  home_label: string
  state: 'open' | 'closed'
  created_at: string
}

const NO_EFFECTS = { effectsApplied: false } as const

/**
 * The Run a paired Orca coordinates here for one conversation, written when its frame arrives and
 * before any await, so a later frame of the same conversation (a cancel) always finds it. The Run
 * keeps its ID across this Orca's resets: a reset that removed its row gets it back on the next call.
 */
export function admitPeerRun(
  this: OrchestrationDb,
  params: { peerFingerprint: string; peerRun: RemoteOwnedPeerRun }
): PeerRunRow {
  const { peerFingerprint, peerRun } = params
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const conversation = this.getPeerMailConversation(peerRun.conversationId)
    const existing = this.getPeerRunForConversation(peerRun.conversationId)
    // A peer-mail conversation keeps its own queue sequence, so it never becomes a peer Run's.
    if (
      existing
        ? existing.peer_fingerprint !== peerFingerprint || existing.home_run_id !== peerRun.runId
        : conversation
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Conversation ${peerRun.conversationId} belongs to another Run or pairing. No effects were applied.`,
        NO_EFFECTS
      )
    }
    const runId = existing?.run_id ?? generateId('run')
    if (existing && existing.home_label !== peerRun.label) {
      this.db
        .prepare('UPDATE peer_runs SET home_label = ? WHERE run_id = ?')
        .run(peerRun.label, runId)
    }
    if (!existing) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO peer_mail_conversations (conversation_id, role, peer_fingerprint)
           VALUES (?, 'peer', ?)`
        )
        .run(peerRun.conversationId, peerFingerprint)
      this.db
        .prepare(
          `INSERT INTO peer_runs (run_id, conversation_id, peer_fingerprint, home_run_id, home_label)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(runId, peerRun.conversationId, peerFingerprint, peerRun.runId, peerRun.label)
    }
    if (!this.getRunRaw(runId)) {
      const coordinator = peerCoordinatorAddress(peerRun.conversationId)
      this.insertRunRow(runId, {
        objective: `Coordinated from ${peerRun.label}`,
        coordinatorHandle: coordinator,
        coordinatorPaneKey: coordinator
      })
    }
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the committed transaction above wrote or found this conversation's row.
  return this.getPeerRunForConversation(peerRun.conversationId) as PeerRunRow
}

export function getPeerRun(this: OrchestrationDb, runId: string): PeerRunRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table returns exactly its row shape.
  return this.db.prepare('SELECT * FROM peer_runs WHERE run_id = ?').get(runId) as
    | PeerRunRow
    | undefined
}

export function hasPeerRuns(this: OrchestrationDb): boolean {
  return this.db.prepare('SELECT 1 FROM peer_runs LIMIT 1').get() !== undefined
}

export function getPeerRunForConversation(
  this: OrchestrationDb,
  conversationId: string
): PeerRunRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table returns exactly its row shape.
  return this.db
    .prepare('SELECT * FROM peer_runs WHERE conversation_id = ?')
    .get(conversationId) as PeerRunRow | undefined
}

/** Closed for good: the claim refuses every start, follow-up and helper into it from now on. */
export function closePeerRun(this: OrchestrationDb, runId: string): void {
  this.db.prepare(`UPDATE peer_runs SET state = 'closed' WHERE run_id = ?`).run(runId)
}

/** Inside a reset's transaction, before it deletes them: one final item per peer-Run Dispatch. */
export function queueRemovedPeerRunDispatches(this: OrchestrationDb, reason: string): void {
  const [allocate, queue] = peerRunDispatchStateStatements(
    '?1',
    false,
    `json_object('reason', ?2)`
  ).map((sql) => this.db.prepare(sql))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT of one column returns exactly that column.
  const dispatches = this.db
    .prepare(
      `SELECT d.id FROM dispatch_contexts d JOIN peer_runs pr ON pr.run_id = d.run_id ORDER BY d.rowid`
    )
    .all() as { id: string }[]
  for (const { id } of dispatches) {
    allocate.run(id, reason)
    queue.run(id, reason)
  }
}

export type PeerRunStoreMethods = {
  admitPeerRun: typeof admitPeerRun
  getPeerRun: typeof getPeerRun
  getPeerRunForConversation: typeof getPeerRunForConversation
  hasPeerRuns: typeof hasPeerRuns
  closePeerRun: typeof closePeerRun
  queueRemovedPeerRunDispatches: typeof queueRemovedPeerRunDispatches
}

export function attachPeerRunStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    admitPeerRun,
    getPeerRun,
    getPeerRunForConversation,
    hasPeerRuns,
    closePeerRun,
    queueRemovedPeerRunDispatches
  })
}
