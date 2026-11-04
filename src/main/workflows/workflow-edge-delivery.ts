import { randomUUID } from 'node:crypto'
import { authorizeWorkflowMessage } from '../../shared/workflow/workflow-communication-policy'
import {
  buildWorkflowEdgePayload,
  estimateWorkflowTokens,
  workflowPayloadBytes
} from '../../shared/workflow/workflow-payload-policy'
import { appendWorkflowEvent, findWorkflowNode } from '../../shared/workflow/workflow-run-state'
import type {
  WorkflowCommunicationEdge,
  WorkflowMessageType
} from '../../shared/workflow/workflow-communication-schema'
import type { WorkflowNode } from '../../shared/workflow/workflow-definition-schema'
import type {
  WorkflowMessage,
  WorkflowRun,
  WorkflowTask
} from '../../shared/workflow/workflow-run-types'
import type { WorkflowPromptInput } from '../../shared/workflow/workflow-prompt-assembly'

/** The type a controller-carried payload travels as, so route type filters mean the same thing everywhere. */
export function controllerMessageType(
  source: WorkflowNode,
  edge: WorkflowCommunicationEdge
): WorkflowMessageType {
  if (edge.policy.payload.kind === 'task-spec') {
    return 'task-assignment'
  }
  if (source.kind === 'reviewer') {
    return 'review-feedback'
  }
  if (edge.policy.payload.kind === 'git-diff-ref' || edge.policy.payload.kind === 'artifact-refs') {
    return 'artifact'
  }
  return 'completion'
}

/** The sender's most recent completed task, across loop iterations. */
function latestCompletedTask(run: WorkflowRun, nodeId: string): WorkflowTask | null {
  return (
    Object.values(run.tasks)
      .filter((task) => task.nodeId === nodeId && task.status === 'completed' && task.report)
      .sort((a, b) => b.iteration - a.iteration)[0] ?? null
  )
}

export type WorkflowEdgeInputs = {
  inputs: WorkflowPromptInput[]
  /** A held message blocks dispatch until the user releases or drops it. */
  held: boolean
  failTaskReason: string | null
}

export function recordWorkflowMessage(
  run: WorkflowRun,
  message: Omit<WorkflowMessage, 'id' | 'runId'>
): WorkflowMessage {
  const full: WorkflowMessage = { id: `wfm_${randomUUID()}`, runId: run.id, ...message }
  run.messages.push(full)
  return full
}

function inputFromMessage(
  run: WorkflowRun,
  message: WorkflowMessage,
  edge: WorkflowCommunicationEdge
): WorkflowPromptInput {
  return {
    from: findWorkflowNode(run.definition, edge.source).label,
    route: edge.name || edge.id,
    payloadKind: edge.policy.payload.kind,
    payload: message.payload
  }
}

/** Assemble a task's inbound payloads under each route's policy; call inside a session turn. */
export function collectWorkflowEdgeInputs(
  run: WorkflowRun,
  task: WorkflowTask,
  at: string
): WorkflowEdgeInputs {
  const result: WorkflowEdgeInputs = { inputs: [], held: false, failTaskReason: null }
  for (const edge of run.definition.communication) {
    if (!edge.enabled || edge.target !== task.nodeId) {
      continue
    }
    const existing = run.messages.find(
      (message) =>
        message.channel === 'controller' &&
        message.taskKey === task.key &&
        message.edgeId === edge.id
    )
    if (existing) {
      if (existing.deliveryState === 'held') {
        result.held = true
      } else if (existing.deliveryState === 'delivered' || existing.deliveryState === 'truncated') {
        result.inputs.push(inputFromMessage(run, existing, edge))
      }
      continue
    }
    const sourceTask = latestCompletedTask(run, edge.source)
    if (!sourceTask?.report) {
      continue
    }
    const source = findWorkflowNode(run.definition, edge.source)
    const built = buildWorkflowEdgePayload({
      policy: edge.policy.payload,
      report: sourceTask.report,
      recipientNodeId: task.nodeId,
      senderWorktreeId: sourceTask.dispatches.at(-1)?.orcaWorktreeId ?? null
    })
    const type = controllerMessageType(source, edge)
    const decision = authorizeWorkflowMessage({
      edges: run.definition.communication,
      policies: run.definition.policies,
      history: run.messages,
      request: {
        sourceNodeId: edge.source,
        destinationNodeId: task.nodeId,
        type,
        channel: 'controller',
        payload: built.text,
        payloadFormat: built.format,
        now: Date.parse(at)
      }
    })
    const payload = decision.action === 'reject' ? built.text : decision.payload
    const bytes = workflowPayloadBytes(payload)
    const message = recordWorkflowMessage(run, {
      edgeId: edge.id,
      sourceNodeId: edge.source,
      destinationNodeId: task.nodeId,
      taskKey: task.key,
      orcaDispatchId: null,
      orcaMessageId: null,
      type,
      channel: 'controller',
      timestamp: at,
      correlationId: `${run.id}:${task.key}:${edge.id}`,
      payload: edge.policy.logging === 'metadata' && decision.action === 'reject' ? '' : payload,
      payloadFormat: built.format,
      deliveryState:
        decision.action === 'reject'
          ? 'rejected'
          : decision.action === 'hold'
            ? 'held'
            : decision.truncated
              ? 'truncated'
              : 'delivered',
      releasedAt: null,
      rejection:
        decision.action === 'reject' ? { code: decision.code, reason: decision.reason } : null,
      bytes,
      estimatedTokens: estimateWorkflowTokens(bytes)
    })
    const refs = { task, correlationId: message.correlationId, data: { edgeId: edge.id, bytes } }
    if (decision.action === 'reject') {
      appendWorkflowEvent(
        run,
        'message-rejected',
        at,
        `${edge.name || edge.id}: ${decision.reason}`,
        refs
      )
      if (decision.failTask) {
        result.failTaskReason = decision.reason
      }
    } else if (decision.action === 'hold') {
      appendWorkflowEvent(
        run,
        'message-held',
        at,
        `${edge.name || edge.id}: ${decision.reason}`,
        refs
      )
      result.held = true
    } else {
      appendWorkflowEvent(
        run,
        'message-delivered',
        at,
        `${source.label} → ${findWorkflowNode(run.definition, task.nodeId).label} (${edge.policy.payload.kind}, ${bytes} B)`,
        refs
      )
      result.inputs.push(inputFromMessage(run, message, edge))
    }
  }
  return result
}
