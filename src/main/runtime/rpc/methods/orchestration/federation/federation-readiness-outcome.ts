import type { RuntimeTerminalWait } from '../../../../../../shared/runtime-types'
import { describeTerminalWaitBlockedReason } from '../../../../../../shared/terminal-wait-blocked-reason-legacy-alias'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerSetupReceipt } from '../worker/worker-topology'
import type { OrchestrationWorkerLaunchReceipt } from '../worker/worker-launch-preferences'
import type { FederationEffect } from './federation-effects'

type FederatedReadinessOutcome =
  | { state: 'ready'; capability: string }
  | { state: 'failed'; stage: string; reason: string }
  | { state: 'unknown'; receipt: unknown }

export function prepareFederatedReadinessOutcome(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  wait: RuntimeTerminalWait
  worktreeId: string
  terminalHandle: string
  terminalOwnership: 'created' | 'external'
  setup: WorkerSetupReceipt
  launch: OrchestrationWorkerLaunchReceipt
  effects: FederationEffect[]
}): FederatedReadinessOutcome {
  const reason = args.wait.blockedReason
    ? `Agent startup blocked: ${describeTerminalWaitBlockedReason(args.wait.blockedReason)}`
    : `Agent startup readiness could not be verified (${args.wait.readiness?.state ?? args.wait.status}); no prompt was submitted.`
  if (!args.wait.satisfied) {
    const setupFailed =
      args.setup.startupPolicy === 'wait-for-setup' &&
      (args.setup.state === 'failed' || args.wait.status === 'exited')
    const knownAgentExit =
      args.setup.startupPolicy !== 'wait-for-setup' && args.wait.status === 'exited'
    if (setupFailed || knownAgentExit) {
      return { state: 'failed', stage: setupFailed ? 'setup_wait' : 'agent_readiness', reason }
    }
  }

  const authority = args.runtime.getOrchestrationDispatchAuthority(args.terminalHandle)
  const paneKey = authority?.paneKey ?? args.runtime.getTerminalPaneKey(args.terminalHandle)
  const processIncarnation =
    authority?.processIncarnation ?? args.runtime.getTerminalProcessIncarnation(args.terminalHandle)
  if (!paneKey || !processIncarnation) {
    throw new Error('stable_pane_required')
  }
  const capability = args.db.prepareRemoteAttachmentAuthority({
    dispatchId: args.dispatchId,
    paneKey,
    processIncarnation,
    worktreeId: args.worktreeId,
    terminalHandle: args.terminalHandle,
    setupState: args.setup.state,
    effects: args.effects,
    hostScope: authority?.hostScope ? JSON.stringify(authority.hostScope) : null,
    terminalOwnership: args.terminalOwnership
  })
  if (args.wait.satisfied) {
    return { state: 'ready', capability }
  }

  const attachment = args.db.markRemoteAttachmentStartUnknown(
    args.dispatchId,
    'agent_readiness',
    reason
  )
  return {
    state: 'unknown',
    receipt: {
      dispatchId: args.dispatchId,
      state: 'outcome_unknown',
      stage: attachment.stage,
      runtimeEpoch: args.runtime.getRuntimeId(),
      worktreeId: args.worktreeId,
      terminalHandle: args.terminalHandle,
      setup: args.setup,
      launch: args.launch,
      effects: args.effects,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attachment authority persists residual_resources as a JSON array.
      residualResources: JSON.parse(attachment.residual_resources) as unknown[]
    }
  }
}
