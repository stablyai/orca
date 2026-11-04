import {
  assembleWorkflowPrompt,
  type WorkflowPromptRoute
} from '../../shared/workflow/workflow-prompt-assembly'
import { workflowModelRefusal } from '../../shared/workflow/workflow-agent-validation'
import {
  isWorkflowAgentNode,
  type WorkflowAgentNode
} from '../../shared/workflow/workflow-definition-schema'
import {
  appendWorkflowEvent,
  currentWorkflowTask,
  findWorkflowNode
} from '../../shared/workflow/workflow-run-state'
import { failWorkflowTaskAttempt } from '../../shared/workflow/workflow-task-settlement'
import type {
  WorkflowDispatch,
  WorkflowRun,
  WorkflowTask
} from '../../shared/workflow/workflow-run-types'
import { collectWorkflowEdgeInputs } from './workflow-edge-delivery'
import { WorkflowOrcaCallError } from './workflow-orca-adapter'
import type { WorkflowWorkerStartReceipt } from './workflow-orca-receipts'
import type { WorkflowRunSession } from './workflow-run-session'

const WORKER_STARTED_STATES = new Set(['ready', 'starting', 'succeeded'])

type DispatchPlan = {
  task: WorkflowTask
  node: WorkflowAgentNode
  dispatch: WorkflowDispatch
  omitModel: boolean
  retryOf: string | null
}

function directRoutes(run: WorkflowRun, nodeId: string): WorkflowPromptRoute[] {
  return run.definition.communication
    .filter((edge) => edge.enabled && edge.source === nodeId)
    .map((edge) => {
      const peer = currentWorkflowTask(run, edge.target)
      const live = peer.status === 'running' ? peer.dispatches.at(-1)?.orcaDispatchId : null
      return {
        label: findWorkflowNode(run.definition, edge.target).label,
        address: live ? `dispatch:${live}` : null
      }
    })
}

/** Inside a turn: build inputs and the prompt, then record the attempt before any Orca effect. */
function prepare(session: WorkflowRunSession, taskKey: string): DispatchPlan | null {
  const run = session.run
  const task = run.tasks[taskKey]
  if (!task || task.status !== 'dispatched' || session.terminal) {
    return null
  }
  const node = findWorkflowNode(run.definition, task.nodeId)
  if (!isWorkflowAgentNode(node)) {
    return null
  }
  const at = session.at()
  if (!task.prompt) {
    const edges = collectWorkflowEdgeInputs(run, task, at)
    if (edges.failTaskReason) {
      failWorkflowTaskAttempt(run, task.key, edges.failTaskReason, at)
      return null
    }
    if (edges.held) {
      // Held input blocks this task until the user releases or drops it.
      task.status = 'blocked'
      return null
    }
    task.prompt = assembleWorkflowPrompt({
      node,
      policies: run.definition.policies,
      variables: {
        objective: run.objective,
        runId: run.id,
        nodeId: node.id,
        nodeLabel: node.label,
        iteration: task.iteration
      },
      inputs: edges.inputs,
      routes: directRoutes(run, node.id)
    })
  }
  const refusal = workflowModelRefusal(node, true)
  const previous = task.dispatches.at(-1)
  const dispatch: WorkflowDispatch = {
    attempt: task.dispatches.length + 1,
    requestId: `${run.id}:${task.key}:attempt-${task.dispatches.length + 1}`,
    orcaDispatchId: null,
    orcaTerminalHandle: null,
    orcaPaneKey: null,
    orcaWorktreeId: null,
    state: 'starting',
    requested: { ...node.agent.runtime },
    effective: null,
    startedAt: at,
    settledAt: null,
    error: null
  }
  task.dispatches.push(dispatch)
  return {
    task,
    node,
    dispatch,
    omitModel: refusal !== null && node.agent.runtime.allowModelFallback,
    retryOf: previous?.orcaDispatchId ?? null
  }
}

function applyReceipt(
  session: WorkflowRunSession,
  plan: DispatchPlan,
  receipt: WorkflowWorkerStartReceipt
): void {
  const { task, dispatch } = plan
  const at = session.at()
  dispatch.orcaDispatchId = receipt.orcaDispatchId ?? dispatch.orcaDispatchId
  dispatch.orcaTerminalHandle = receipt.terminalHandle
  dispatch.orcaPaneKey = receipt.terminalHandle
    ? session.deps.adapter.paneKeyFor(receipt.terminalHandle)
    : null
  dispatch.orcaWorktreeId = receipt.worktreeId
  dispatch.effective = receipt.effective
  const refs = { task, orcaDispatchId: dispatch.orcaDispatchId, correlationId: dispatch.requestId }
  if (receipt.state === 'failed') {
    dispatch.state = 'failed'
    dispatch.settledAt = at
    dispatch.error =
      receipt.error ?? `Worker start failed at ${receipt.failedStage ?? 'an unknown stage'}.`
    appendWorkflowEvent(
      session.run,
      'agent-start-failed',
      at,
      `${plan.node.label}: ${dispatch.error}`,
      refs
    )
    failWorkflowTaskAttempt(session.run, task.key, dispatch.error, at)
    return
  }
  // Only a proven start counts as running; any other state is left for reconciliation to prove.
  if (!WORKER_STARTED_STATES.has(receipt.state) || !dispatch.orcaDispatchId) {
    dispatch.state = 'unknown'
    task.status = 'unknown'
    appendWorkflowEvent(
      session.run,
      'task-unknown',
      at,
      `${plan.node.label}: Orca could not confirm the worker started; reconciling.`,
      refs
    )
    return
  }
  dispatch.state = 'running'
  task.status = 'running'
  task.startedAt ??= at
  const model = receipt.effective?.model ?? 'agent default'
  appendWorkflowEvent(
    session.run,
    'agent-dispatched',
    at,
    `${plan.node.label} dispatched to ${plan.node.agent.runtime.agent} (${model}).`,
    refs
  )
  appendWorkflowEvent(
    session.run,
    'agent-started',
    at,
    `${plan.node.label} attempt ${dispatch.attempt} is running.`,
    refs
  )
}

/** A refusal proves nothing started; anything else leaves the outcome for reconciliation to prove. */
function applyError(session: WorkflowRunSession, plan: DispatchPlan, error: unknown): void {
  const at = session.at()
  const message = error instanceof Error ? error.message : String(error)
  const refusal = error instanceof WorkflowOrcaCallError
  plan.dispatch.error = message
  plan.dispatch.settledAt = refusal ? at : null
  plan.dispatch.state = refusal ? 'failed' : 'unknown'
  if (refusal) {
    appendWorkflowEvent(session.run, 'agent-start-failed', at, `${plan.node.label}: ${message}`, {
      task: plan.task
    })
    failWorkflowTaskAttempt(session.run, plan.task.key, message, at)
  } else {
    plan.task.status = 'unknown'
    appendWorkflowEvent(
      session.run,
      'task-unknown',
      at,
      `${plan.node.label}: start outcome unknown (${message}).`,
      { task: plan.task }
    )
  }
}

export async function dispatchWorkflowAgent(
  session: WorkflowRunSession,
  taskKey: string
): Promise<void> {
  const plan = await session.exclusive(() => {
    const prepared = prepare(session, taskKey)
    session.persist()
    return prepared
  })
  if (!plan) {
    await session.schedule()
    return
  }
  const { run, deps } = session
  const from = run.coordinatorTerminalHandle
  const orcaRunId = run.orcaRunId
  try {
    if (!from || !orcaRunId) {
      throw new WorkflowOrcaCallError(
        'workflow',
        'not_launched',
        'The workflow has no Orca Run yet.'
      )
    }
    let orcaTaskId = plan.task.orcaTaskId
    if (!orcaTaskId) {
      orcaTaskId = await deps.adapter.createTask({
        from,
        orcaRunId,
        spec: plan.task.prompt?.text ?? '',
        title: `wf:${run.id}:${plan.task.key}`,
        displayName: plan.node.label,
        requestId: `${run.id}:${plan.task.key}:task`
      })
      const created = orcaTaskId
      await session.exclusive(() => {
        plan.task.orcaTaskId = created
        session.persist()
      })
    }
    const runtime = plan.node.agent.runtime
    const receipt = await deps.adapter.startWorker({
      from,
      orcaRunId,
      orcaTaskId,
      agent: runtime.agent,
      model: plan.omitModel ? null : runtime.model,
      effort: plan.omitModel ? null : runtime.effort,
      worktree: plan.node.agent.placement.worktree,
      displayName: plan.node.label,
      timeoutMs: null,
      retryOf: plan.retryOf,
      requestId: plan.dispatch.requestId
    })
    await session.exclusive(() => {
      applyReceipt(session, plan, receipt)
      session.persist()
    })
  } catch (error) {
    await session.exclusive(() => {
      applyError(session, plan, error)
      session.persist()
    })
  }
  await session.schedule()
}
