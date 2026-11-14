/** What a coordinator is told about a worker's permission prompt: who may answer, and how it closed. */
import type { WorkerApprovalPayload } from '../../../../../shared/orchestration/approvals/worker-approval-payload'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../shared/orca-session-address-prefix'

/** With the user's setting on: the coordinator may answer too, and the first answer wins. */
export function describeCoordinatorAnswer(
  { approvalId, allowedActions, personOnly, worker }: WorkerApprovalPayload,
  { dispatchId, chatCoordinator }: { dispatchId: string; chatCoordinator?: boolean }
): string[] {
  const shown = allowedActions.map((action) => (action === 'allow' ? 'Allow' : 'Deny')).join('/')
  const where = worker.handle.startsWith(ORCA_SESSION_ADDRESS_PREFIX)
    ? ` in the worker's chat`
    : ` in the worker's terminal`
  const approve = allowedActions.includes('allow') && !personOnly
  const deny = allowedActions.includes('deny')
  const commands = [
    ...(approve
      ? [
          `\`orchestration approve --dispatch ${dispatchId} --prompt ${approvalId} --reason "<reason>"\``
        ]
      : []),
    ...(deny
      ? [
          `\`orchestration deny --dispatch ${dispatchId} --prompt ${approvalId} --reason "<what to do instead>"\``
        ]
      : [])
  ]
  const how = approve
    ? deny
      ? 'You can approve or deny it, with a reason:'
      : 'You can approve it, with a reason:'
    : `${personOnly ? "The worker's agent lets only a person approve this one." : 'Orca cannot approve this one.'}${deny ? ' You can deny it, with a reason:' : ''}`
  return [
    `The user has been shown ${shown}${chatCoordinator ? '' : where} too; whoever answers first wins. ${how}`,
    ...commands,
    'Or leave it for the user and carry on with other work.'
  ]
}

const CLOSED_BY: Record<NonNullable<WorkerApprovalPayload['outcome']>['by'], string> = {
  person: 'by a person in Orca',
  coordinator: 'by the coordinator',
  'worker-chat': "in the worker's own chat",
  'worker-terminal': "in the worker's terminal",
  auto: "by the worker's agent on its own (its 2:00 timeout)",
  'terminal-only': "for Orca; a person must answer it in the worker's terminal",
  'worker-ended': 'because its worker ended',
  unknown: 'without an answer Orca can name'
}

export function describeApprovalClosed(approval: WorkerApprovalPayload): string {
  const { outcome, approvalId, worker } = approval
  const decision =
    outcome?.decision === 'allow' ? 'Allowed' : outcome?.decision === 'deny' ? 'Denied' : 'Closed'
  return [
    `${decision} ${CLOSED_BY[outcome?.by ?? 'unknown']}: approval ${approvalId} of worker ${worker.handle} (${approval.summary.title}).`,
    ...(outcome?.reason
      ? [
          `Reason: ${outcome.reason}`,
          ...(outcome.reasonDelivered || outcome.decision !== 'deny'
            ? []
            : [
                "This agent's prompt takes no message, so the reason was sent to the worker as mail."
              ])
        ]
      : []),
    outcome?.by === 'terminal-only'
      ? "Tell the user to answer it in the worker's terminal."
      : 'Nothing to do unless the worker stays stuck.'
  ].join('\n')
}
