import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { FederationEffect } from './federation-effects'
import type { WorkerSetupReceipt } from '../worker/worker-topology'
import type { StructuredWorkerIdentity } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'

export function prepareFederatedAttachmentAuthority(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  terminalHandle: string
  worktreeId: string
  setup: WorkerSetupReceipt
  effects: FederationEffect[]
  reusesTerminal: boolean
  /** A chat worker's minted identity, which stands in for a terminal's pane and process. */
  identity?: Pick<StructuredWorkerIdentity, 'paneKey' | 'processIncarnation' | 'hostScope'>
}): void {
  const { runtime, terminalHandle } = args
  const authority = args.identity ?? runtime.getOrchestrationDispatchAuthority(terminalHandle)
  const paneKey = authority?.paneKey ?? runtime.getTerminalPaneKey(terminalHandle)
  const processIncarnation =
    authority?.processIncarnation ?? runtime.getTerminalProcessIncarnation(terminalHandle)
  if (!paneKey || !processIncarnation) {
    throw new Error('stable_pane_required')
  }
  args.db.prepareRemoteAttachmentAuthority({
    dispatchId: args.dispatchId,
    paneKey,
    processIncarnation,
    worktreeId: args.worktreeId,
    terminalHandle,
    setupState: args.setup.state,
    effects: args.effects,
    hostScope: authority?.hostScope ? JSON.stringify(authority.hostScope) : null,
    terminalOwnership: args.reusesTerminal ? 'external' : 'created'
  })
  // Why: a reused pane may hold an earlier agent's exit; only exits after this attach are the worker's.
  runtime.forgetTerminalAgentExit(terminalHandle)
}
