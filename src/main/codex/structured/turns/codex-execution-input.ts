import { assertCodexExecutionCapacity } from './codex-execution-capacity'
import { assertCodexExecutionSource } from './codex-execution-source'
import { StructuredAgentSessionInputNotAdmitted } from '../../../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { CodexSession } from '../session-lifecycle/codex-structured-session-state'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { codexDispatchRejection } from './codex-structured-turn-end-settlement'
import { persistCodexExecutionReceipt } from '../session-lifecycle/codex-execution-receipt'

export function refuseCodexExecutionInput(
  stage: 'controls' | 'state' | 'evidence' | 'capacity' | 'source' | 'freshness' = 'controls'
): never {
  throw new StructuredAgentSessionInputNotAdmitted({
    state: 'rejected',
    ...codexDispatchRejection(agentSessionFailureFact('hostFault', { neverReachedAgent: true })),
    reason: `Orca refused bounded Codex input during ${stage}.`
  })
}

export async function prepareCodexExecutionInput(
  session: CodexSession,
  input: Pick<
    Parameters<StructuredAgentSessionAdapter['dispatch']>[0],
    'sessionId' | 'fence' | 'signal'
  >,
  options: Readonly<Record<string, string>> | undefined,
  registered: () => boolean,
  read: NonNullable<StructuredAgentSessionAdapter['readExecutionEvidence']>
) {
  const execution = session.execution
  if (!execution) {
    return undefined
  }
  if (
    execution.inputAdmitted ||
    !execution.controls.isOpen() ||
    !execution.record ||
    !execution.reporter
  ) {
    refuseCodexExecutionInput('state')
  }
  const captured = await read(input)
  const evidence = captured?.evidence
  const policy = execution.policy
  if (
    !captured ||
    !evidence ||
    !captured.isCurrent() ||
    !registered() ||
    evidence.account.fingerprint !== policy.accountFingerprint ||
    evidence.model !== policy.model ||
    evidence.effort !== policy.effort ||
    evidence.cwd !== session.permissions?.cwd ||
    evidence.runtimeWorkspaceRoots?.length !== 1 ||
    evidence.runtimeWorkspaceRoots[0] !== evidence.cwd ||
    evidence.permissions.activeProfile?.id !== execution.profileId ||
    evidence.permissions.approvalPolicy !== 'never' ||
    evidence.permissions.approvalsReviewer !== 'user' ||
    evidence.permissions.sandbox.type !==
      (policy.access === 'workspace' ? 'workspaceWrite' : 'readOnly') ||
    (options?.model !== undefined && options.model !== policy.model) ||
    (options?.effort !== undefined && options.effort !== policy.effort) ||
    (options?.serviceTier !== undefined && options.serviceTier !== 'default')
  ) {
    refuseCodexExecutionInput('evidence')
  }
  try {
    await assertCodexExecutionCapacity(session)
  } catch {
    refuseCodexExecutionInput('capacity')
  }
  try {
    await assertCodexExecutionSource(evidence.cwd, policy.sourcePin)
  } catch {
    refuseCodexExecutionInput('source')
  }
  await persistCodexExecutionReceipt(session)
  return () => {
    if (
      input.signal?.aborted ||
      !registered() ||
      !captured.isCurrent() ||
      execution.inputAdmitted ||
      !execution.controls.isOpen()
    ) {
      refuseCodexExecutionInput('freshness')
    }
    execution.inputAdmitted = true
    execution.checkpoint?.()
  }
}

export function codexExecutionTurnSettings(
  session: Pick<CodexSession, 'execution' | 'permissions'>,
  options: Readonly<Record<string, string>>
) {
  const execution = session.execution
  if (!execution) {
    return undefined
  }
  if (
    !execution.controls.isOpen() ||
    execution.inputAdmitted ||
    (options.model !== undefined && options.model !== execution.policy.model) ||
    (options.effort !== undefined && options.effort !== execution.policy.effort) ||
    (options.serviceTier !== undefined && options.serviceTier !== 'default')
  ) {
    refuseCodexExecutionInput()
  }
  return {
    permissions: execution.profileId,
    runtimeWorkspaceRoots: [session.permissions!.cwd],
    model: execution.policy.model,
    effort: execution.policy.effort,
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    serviceTierForTurn: 'default'
  }
}
