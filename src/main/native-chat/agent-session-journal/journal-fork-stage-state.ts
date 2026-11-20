import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalForkStageBegin, JournalForkStages } from './journal-fork-stages'
import type Database from '../../sqlite/sync-database'
type Auxiliary = {
  item: AgentJournalRenderItem
  ordinal: number
  oldNames: readonly string[]
  oldName: number
  names: readonly string[]
  name: number
  claims: readonly string[]
  claim: number
}
export type Stage = JournalForkStageBegin & {
  token: string
  epoch: string
  priorSequence: number
  priorRecord: string | null
  count: number
  lastItemId: string | null
  derived: string | null
  lastActivity: number
  auxiliary?: Auxiliary
}

const owners = new WeakMap<Database.Database, JournalForkStages>()
export function journalForkStageHeld(
  db: Database.Database,
  sessionId: string,
  epoch?: string
): boolean {
  return owners.get(db)?.holds(sessionId, epoch) ?? false
}
export function journalForkAttachmentHeld(db: Database.Database, sessionId: string): boolean {
  return owners.get(db)?.holdsAttachments(sessionId) ?? false
}
export function journalForkStageEpochs(db: Database.Database, sessionId: string): string[] {
  return owners.get(db)?.epochs(sessionId) ?? []
}

export function registerJournalForkStages(db: Database.Database, owner: JournalForkStages): void {
  owners.set(db, owner)
}
