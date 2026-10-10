/**
 * Lets an SSH host's relayed `orca` CLI take part in orchestration as that host's own terminals.
 *
 * Without the per-target opt-in, the caller (`from` / `terminal`) must be a terminal on the bridged
 * host. A party outside the host is reachable only as the coordinator of a Dispatch the caller works
 * on, so a worker reports back to whoever dispatched it but cannot message or read anyone else.
 * Routing stores mail under `run:`/`dispatch:` addresses, so ownership is resolved to those exact
 * mailboxes the caller's live pane reads, never to a Run it merely shares.
 */
import { z } from 'zod'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from '../orchestration/db'
import {
  resolveTerminalOwnedMailboxes,
  type TerminalOwnedMailboxes
} from './methods/orchestration/messaging/terminal-owned-mailboxes'

const TERMINAL_CALLER_METHODS: ReadonlySet<string> = new Set([
  'orchestration.check',
  'orchestration.inbox'
])

export const SSH_BRIDGE_ORCHESTRATION_METHODS: readonly string[] = [
  ...TERMINAL_CALLER_METHODS,
  'orchestration.send',
  'orchestration.ask',
  'orchestration.reply'
]

/** The refused subject, or null when the call stays inside the caller's own orchestration. */
export async function findSshBridgeOrchestrationViolation(
  runtime: OrcaRuntimeService,
  hostId: ExecutionHostId,
  methodName: string,
  selectors: SshBridgeSelectors
): Promise<string | null> {
  const caller = selectors[TERMINAL_CALLER_METHODS.has(methodName) ? 'terminal' : 'from']
  if (!caller || !(await isHostTerminal(runtime, hostId, caller))) {
    return `terminal '${caller ?? ''}'`
  }
  const paneKey = runtime.getTerminalPaneKey(caller) ?? undefined
  const claimedPane =
    selectors[methodName === 'orchestration.check' ? 'terminalPaneKey' : 'senderPaneKey']
  // Why: the pane key is the lifecycle identity, so it must be the caller's own, not a sibling's.
  if (claimedPane && claimedPane !== paneKey) {
    return `pane '${claimedPane}'`
  }
  const db = runtime.getOrchestrationDb()
  const ownDispatch = db.getActiveDispatchForIdentity(caller, paneKey)
  const run = selectors.run
  if (run && ownDispatch?.run_id !== run && db.getRun(run)?.coordinator_handle !== caller) {
    return `run '${run}'`
  }
  const owned = resolveTerminalOwnedMailboxes(runtime, db, caller)
  if (methodName === 'orchestration.reply') {
    const id = selectors.id ?? ''
    const original = db.getMessageById(id)
    return original && owned.addresses.has(original.to_handle) && (!run || run === original.run_id)
      ? null
      : `message '${id}'`
  }
  if (TERMINAL_CALLER_METHODS.has(methodName)) {
    return null
  }
  const dispatchId = readPayloadDispatchId(selectors)
  if (dispatchId) {
    const named = db.getDispatchContextById(dispatchId)
    const party =
      named &&
      (named.assignee_handle === caller ||
        (paneKey !== undefined && named.assignee_pane_key === paneKey) ||
        named.creator_handle === caller)
    if (!party) {
      return `dispatch '${dispatchId}'`
    }
  }
  const to = selectors.to
  if (
    !to ||
    (ownDispatch?.creator_handle && to === ownDispatch.creator_handle) ||
    (await isOwnCanonicalRecipient(db, owned, runtime, hostId, to))
  ) {
    return null
  }
  return (await isHostTerminal(runtime, hostId, to)) ? null : `recipient '${to}'`
}

// A canonical address is in scope when it is the caller's own mailbox, the Run mailbox its held
// Dispatch reports to, or a same-host worker's Dispatch in the Run the caller coordinates.
async function isOwnCanonicalRecipient(
  db: OrchestrationDb,
  owned: TerminalOwnedMailboxes,
  runtime: OrcaRuntimeService,
  hostId: ExecutionHostId,
  to: string
): Promise<boolean> {
  if (owned.addresses.has(to) || (owned.dispatch && to === `run:${owned.dispatch.run_id}`)) {
    return true
  }
  if (!to.startsWith('dispatch:') || owned.runId === undefined) {
    return false
  }
  const dispatch = db.getDispatchContextById(to.slice('dispatch:'.length))
  return (
    dispatch?.run_id === owned.runId &&
    dispatch.assignee_handle !== null &&
    (await isHostTerminal(runtime, hostId, dispatch.assignee_handle))
  )
}

export async function isHostTerminal(
  runtime: OrcaRuntimeService,
  hostId: ExecutionHostId,
  handle: string
): Promise<boolean> {
  return (await resolveTerminalHost(runtime, handle)) === hostId
}

async function resolveTerminalHost(
  runtime: OrcaRuntimeService,
  handle: string
): Promise<ExecutionHostId | null> {
  try {
    return (await runtime.showTerminal(handle)).executionHostId ?? null
  } catch {
    return null
  }
}

function readPayloadDispatchId(selectors: SshBridgeSelectors): string | null {
  if (!selectors.payload) {
    return null
  }
  try {
    return parseSshBridgeSelectors(JSON.parse(selectors.payload)).dispatchId ?? null
  } catch {
    // Why: the handler owns malformed-payload errors; nothing here can name a Dispatch.
    return null
  }
}

// Why: a missing, non-string or empty selector names nothing, and the handler owns rejecting it.
const BridgeSelector = z.string().min(1).optional().catch(undefined)

/** The selector fields the bridge binds to the caller's host; anything else names nothing. */
const SshBridgeCallSelectors = z
  .object({
    terminal: BridgeSelector,
    terminalPaneKey: BridgeSelector,
    senderPaneKey: BridgeSelector,
    from: BridgeSelector,
    to: BridgeSelector,
    run: BridgeSelector,
    id: BridgeSelector,
    payload: BridgeSelector,
    dispatchId: BridgeSelector,
    worktree: BridgeSelector
  })
  .catch({})

export type SshBridgeSelectors = z.infer<typeof SshBridgeCallSelectors>

export function parseSshBridgeSelectors(params: unknown): SshBridgeSelectors {
  return SshBridgeCallSelectors.parse(params)
}
