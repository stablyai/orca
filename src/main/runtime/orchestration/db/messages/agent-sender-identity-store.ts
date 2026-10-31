import type { OrchestrationDb } from '../orchestration-db'
import type { DispatchCreator } from '../dispatch-depth'

/** Who sent an event, captured when Orca accepts it, never re-read from the pane at delivery.
 *  Subjects: `message:<id>`, `creator:<dispatchId>`, `assignee:<dispatchId>`; write-once. */
export const AGENT_SENDER_IDENTITIES_SQL = `
CREATE TABLE IF NOT EXISTS agent_sender_identities (
  subject  TEXT PRIMARY KEY,
  identity TEXT NOT NULL
);`

export function recordAgentSenderIdentity(
  this: OrchestrationDb,
  subject: string,
  identity: string | null | undefined
): void {
  if (identity) {
    this.db
      .prepare('INSERT OR IGNORE INTO agent_sender_identities (subject, identity) VALUES (?, ?)')
      .run(subject, identity)
  }
}

export function getAgentSenderIdentity(this: OrchestrationDb, subject: string): string | null {
  const row = this.db
    .prepare('SELECT identity FROM agent_sender_identities WHERE subject = ?')
    .get(subject) as { identity: string } | undefined
  return row?.identity ?? null
}

/** A chat creator is already named by its session id; a terminal creator by what ran in its pane. */
export function recordDispatchCreatorIdentity(
  this: OrchestrationDb,
  dispatchId: string,
  creator: DispatchCreator
): void {
  if (creator.kind === 'terminal' && !creator.orcaSessionId) {
    this.recordAgentSenderIdentity(
      `creator:${dispatchId}`,
      this.agentSenderIdentityOf?.(creator.handle, creator.paneKey ?? null)
    )
  }
}

export type AgentSenderIdentityStoreMethods = {
  recordAgentSenderIdentity: typeof recordAgentSenderIdentity
  getAgentSenderIdentity: typeof getAgentSenderIdentity
  recordDispatchCreatorIdentity: typeof recordDispatchCreatorIdentity
}

export function attachAgentSenderIdentityStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    recordAgentSenderIdentity,
    getAgentSenderIdentity,
    recordDispatchCreatorIdentity
  })
}
