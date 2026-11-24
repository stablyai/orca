// Lets the runtime refuse new mail or custody for a chat closed to new work (a bot chat being ended,
// or ended), inside the same write that would have taken it, so a refusal leaves no effect.
import type { OrchestrationDb } from './orchestration-db'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../shared/agent-session/identity/orca-session-address'

/** `mail`: a message to this mailbox; `custody`: a Dispatch assignee or Run coordinator handle. */
export type ChatCustodyWrite = 'mail' | 'custody'

type Guard = (db: OrchestrationDb, handle: string, write: ChatCustodyWrite) => void

let guard: Guard | null = null

export function installChatCustodyGuard(next: Guard | null): void {
  guard = next
}

/** Throws when the runtime refuses this write; called inside the write's transaction. */
export function guardChatCustody(
  db: OrchestrationDb,
  handle: string | null | undefined,
  write: ChatCustodyWrite
): void {
  if (guard && handle) {
    guard(db, handle, write)
  }
}

/** A Run coordinator's chat as a custody handle; null for a terminal coordinator. */
export function coordinatorCustodyHandle(coordinator: {
  orcaSessionId: string | null
}): string | null {
  const id = coordinator.orcaSessionId
  return id && isOrcaSessionId(id) ? formatOrcaSessionAddress(id) : null
}
