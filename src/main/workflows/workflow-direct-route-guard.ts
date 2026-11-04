import { authorizeWorkflowMessage } from '../../shared/workflow/workflow-communication-policy'
import type { WorkflowMessageType } from '../../shared/workflow/workflow-communication-schema'
import {
  estimateWorkflowTokens,
  workflowPayloadBytes
} from '../../shared/workflow/workflow-payload-policy'
import { appendWorkflowEvent, findWorkflowNode } from '../../shared/workflow/workflow-run-state'
import type {
  WorkflowRouteGuard,
  WorkflowRouteGuardInput
} from '../runtime/orchestration/workflow-route-guard'
import type { MessageType } from '../runtime/orchestration/types'
import { recordWorkflowMessage } from './workflow-edge-delivery'
import { findWorkflowTaskForSender } from './workflow-mail-pump'
import type { WorkflowRunSession } from './workflow-run-session'

const ORCA_TO_WORKFLOW_TYPE: Record<MessageType, WorkflowMessageType> = {
  status: 'status-update',
  dispatch: 'task-assignment',
  worker_done: 'completion',
  merge_ready: 'artifact',
  escalation: 'control',
  handoff: 'artifact',
  decision_gate: 'control',
  question: 'question',
  heartbeat: 'control'
}

function recipientTask(session: WorkflowRunSession, to: string) {
  return to.startsWith('dispatch:')
    ? findWorkflowTaskForSender(session.run, { dispatchId: to.slice('dispatch:'.length) })
    : findWorkflowTaskForSender(session.run, { handle: to })
}

/** Worker-to-worker mail inside a workflow Run must follow an enabled route; control mail to the controller always passes. */
export function createWorkflowDirectRouteGuard(session: WorkflowRunSession): WorkflowRouteGuard {
  return (input: WorkflowRouteGuardInput) => {
    const { run } = session
    const coordinator = run.coordinatorTerminalHandle
    if (
      input.to.startsWith('run:') ||
      input.to === coordinator ||
      input.senderHandle === coordinator
    ) {
      return { action: 'allow' }
    }
    const sender = findWorkflowTaskForSender(run, {
      dispatchId: input.senderDispatchId,
      handle: input.senderHandle
    })
    if (!sender) {
      // Not a workflow worker (the user's own terminal, say): outside the workflow's authority.
      return { action: 'allow' }
    }
    const at = session.at()
    const senderLabel = findWorkflowNode(run.definition, sender.nodeId).label
    if (input.to.startsWith('@')) {
      appendWorkflowEvent(
        run,
        'message-rejected',
        at,
        `${senderLabel} tried a group message (${input.to}); workflows allow direct routes only.`,
        { task: sender }
      )
      session.persist()
      return {
        action: 'refuse',
        code: 'workflow_route_refused',
        message:
          'This workflow allows only direct messages along its configured routes. Group addresses are refused.'
      }
    }
    const recipient = recipientTask(session, input.to)
    const type = ORCA_TO_WORKFLOW_TYPE[input.type]
    const body = input.payload ? `${input.body}\n${input.payload}` : input.body
    const decision = recipient
      ? authorizeWorkflowMessage({
          edges: run.definition.communication,
          policies: run.definition.policies,
          history: run.messages,
          request: {
            sourceNodeId: sender.nodeId,
            destinationNodeId: recipient.nodeId,
            type,
            channel: 'direct',
            payload: body,
            payloadFormat: 'text',
            now: Date.parse(at)
          }
        })
      : ({
          action: 'reject',
          edge: null,
          code: 'workflow_recipient_outside',
          reason: 'That recipient is not part of this workflow.',
          failTask: false
        } as const)
    // A worker's own send cannot be rewritten or parked inside Orca, so truncate and hold refuse with guidance.
    const refused = decision.action !== 'deliver' || decision.truncated
    const reason =
      decision.action === 'reject'
        ? decision.reason
        : decision.action === 'hold'
          ? `${decision.reason} Ask the coordinator instead.`
          : decision.truncated
            ? `The message exceeds this route's ${decision.edge.policy.maxMessageBytes}-byte limit. Send a shorter summary.`
            : ''
    const bytes = workflowPayloadBytes(body)
    recordWorkflowMessage(run, {
      edgeId: decision.edge?.id ?? null,
      sourceNodeId: sender.nodeId,
      destinationNodeId: recipient?.nodeId ?? null,
      taskKey: sender.key,
      orcaDispatchId: input.senderDispatchId ?? null,
      orcaMessageId: null,
      type,
      channel: 'direct',
      timestamp: at,
      correlationId: `${run.id}:direct:${run.messages.length}`,
      payload: decision.edge?.policy.logging === 'metadata' ? '' : body,
      payloadFormat: 'text',
      deliveryState: refused ? 'rejected' : 'delivered',
      releasedAt: null,
      rejection: refused
        ? { code: decision.action === 'reject' ? decision.code : 'route_policy', reason }
        : null,
      bytes,
      estimatedTokens: estimateWorkflowTokens(bytes)
    })
    const target = recipient ? findWorkflowNode(run.definition, recipient.nodeId).label : input.to
    appendWorkflowEvent(
      run,
      refused ? 'message-rejected' : 'message-delivered',
      at,
      refused
        ? `${senderLabel} → ${target} refused: ${reason}`
        : `${senderLabel} → ${target} (direct, ${bytes} B)`,
      { task: sender, data: { bytes } }
    )
    session.persist()
    return refused
      ? {
          action: 'refuse',
          code: decision.action === 'reject' ? decision.code : 'workflow_route_refused',
          message: reason
        }
      : { action: 'allow' }
  }
}
