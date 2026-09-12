import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'
import { isDevCliInvocation } from '../orchestration/runtime-compatibility'
import {
  reportMissionAttentionToStderr,
  type MissionAttentionMessage,
  type MissionAttentionReporter
} from './mission-attention-reporting'
import { prepareMissionTasks } from './mission-task-materialization'
import {
  isNoEffectStartFailure,
  markNoEffectFailuresSettled,
  MissionWorkerStartFailure,
  type MissionWorkerStartResult
} from './mission-start-failure'

export type MissionAdmission = {
  acceptedTypes: string[]
  minPriority: 'normal' | 'high' | 'urgent'
}

export type MissionTask = {
  key: string
  spec: string
  deps: string[]
  publishesTo?: string[]
  requiredPublishesTo?: string[]
  subscribesTo?: string[]
  admission?: MissionAdmission
}

export type MissionPlan =
  | { mode: 'single-agent' }
  | {
      mode: 'orchestration'
      objective: string
      maxConcurrency: number
      tasks: MissionTask[]
    }

export type MissionPlanRpcResult = {
  mission: string
  agent: string
  agentCandidates?: string[]
  plan: MissionPlan
}

export type MissionSummary = {
  mission: string
  runId: string
  agent: string
  state: 'completed' | 'failed'
  completedTasks: number
  failedTasks: number
}

type RuntimeTask = {
  id: string
  status: 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'
}

const MISSION_WAIT_TIMEOUT_MS = 600_000

export async function executeMissionRun(input: {
  client: RuntimeClient
  mission: string
  runId: string
  from: string
  worktree: string
  agent: string
  agentCandidates?: readonly string[]
  tasks: readonly MissionTask[]
  maxConcurrency: number
  onAttention?: MissionAttentionReporter
}): Promise<MissionSummary> {
  await prepareMissionTasks(input.client, input.tasks, input.runId, input.from)
  return superviseMission(input)
}

async function superviseMission(input: {
  client: RuntimeClient
  mission: string
  runId: string
  from: string
  worktree: string
  agent: string
  agentCandidates?: readonly string[]
  maxConcurrency: number
  onAttention?: MissionAttentionReporter
}): Promise<MissionSummary> {
  const startAttempted = new Set<string>()
  const startFailures = new Map<string, unknown>()
  const notifiedAttentionDeliveries = new Set<string>()
  const onAttention = input.onAttention ?? reportMissionAttentionToStderr
  for (;;) {
    const listed = await input.client.call<{ tasks: RuntimeTask[]; count: number }>(
      'orchestration.taskList',
      { run: input.runId, callerTerminalHandle: input.from }
    )
    const tasks = listed.result.tasks
    const completed = tasks.filter((task) => task.status === 'completed')
    const failed = tasks.filter((task) => task.status === 'failed')
    const unresolvedStartFailure = getUnresolvedStartFailure(tasks, startFailures)
    if (completed.length + failed.length === tasks.length) {
      if (unresolvedStartFailure) {
        markNoEffectFailuresSettled(startFailures)
        throw unresolvedStartFailure
      }
      return {
        mission: input.mission,
        runId: input.runId,
        agent: input.agent,
        state: failed.length === 0 ? 'completed' : 'failed',
        completedTasks: completed.length,
        failedTasks: failed.length
      }
    }

    const capacity =
      input.maxConcurrency - tasks.filter((task) => task.status === 'dispatched').length
    const wave = tasks
      .filter((task) => task.status === 'ready' && !startAttempted.has(task.id))
      .slice(0, Math.max(0, capacity))
    if (wave.length > 0) {
      const startedWave = await Promise.allSettled(
        wave.map(async (task) => {
          try {
            await startMissionWorker(input, task.id)
          } finally {
            startAttempted.add(task.id)
          }
        })
      )
      for (const [index, result] of startedWave.entries()) {
        if (result.status === 'rejected') {
          startFailures.set(wave[index]!.id, result.reason)
        }
      }
      continue
    }

    const active = tasks.some((task) => task.status === 'dispatched')
    if (!active) {
      if (unresolvedStartFailure) {
        throw unresolvedStartFailure
      }
      const blocked = tasks.filter((task) => task.status === 'blocked')
      throw new RuntimeClientError(
        'mission_stalled',
        blocked.length > 0
          ? `Mission stalled with ${blocked.length} blocked task(s).`
          : 'Mission has no active or ready tasks.'
      )
    }

    const waited = await input.client.call<{
      deliveryId: string | null
      messages?: MissionAttentionMessage[]
      timedOut?: boolean
      cancelled?: boolean
      connectionLost?: boolean
    }>('orchestration.check', {
      terminal: input.from,
      run: input.runId,
      wait: true,
      timeoutMs: MISSION_WAIT_TIMEOUT_MS,
      types: 'worker_done,escalation,question'
    })
    if (waited.result.cancelled) {
      throw new RuntimeClientError(
        'mission_cancelled',
        waited.result.connectionLost
          ? 'Mission coordinator connection closed.'
          : 'Mission wait cancelled.'
      )
    }
    if (waited.result.deliveryId) {
      const attention = (waited.result.messages ?? []).filter(
        (message) => message.type === 'escalation' || message.type === 'question'
      )
      if (attention.length > 0 && !notifiedAttentionDeliveries.has(waited.result.deliveryId)) {
        await onAttention({
          runId: input.runId,
          deliveryId: waited.result.deliveryId,
          messages: attention
        })
        notifiedAttentionDeliveries.add(waited.result.deliveryId)
      }
      await input.client.call('orchestration.check', {
        terminal: input.from,
        run: input.runId,
        ack: waited.result.deliveryId,
        peek: true
      })
    }
  }
}

function getUnresolvedStartFailure(
  tasks: readonly RuntimeTask[],
  startFailures: ReadonlyMap<string, unknown>
): unknown {
  for (const [taskId, error] of startFailures) {
    const task = tasks.find((candidate) => candidate.id === taskId)
    if (task?.status !== 'completed') {
      return error
    }
  }
  return null
}

const RETRYABLE_WORKER_START_STAGES = new Set(['terminal_create', 'agent_readiness'])

async function startMissionWorker(
  input: {
    client: RuntimeClient
    runId: string
    from: string
    worktree: string
    agent: string
    agentCandidates?: readonly string[]
  },
  taskId: string
): Promise<void> {
  const candidates = input.agentCandidates?.length ? input.agentCandidates : [input.agent]
  const failures: string[] = []
  let retryOf: string | undefined
  let allAttemptsHaveNoResidualEffects = true

  for (const [index, agent] of candidates.entries()) {
    try {
      const worker = await input.client.call<MissionWorkerStartResult>(
        'orchestration.workerStart',
        {
          task: taskId,
          run: input.runId,
          from: input.from,
          worktree: input.worktree,
          agent,
          ...(retryOf ? { retryOf } : {}),
          devMode: isDevCliInvocation()
        }
      )
      if (worker.result.state === 'ready') {
        return
      }
      allAttemptsHaveNoResidualEffects &&= isNoEffectStartFailure(worker.result)

      const reason =
        worker.result.lastError ?? `Worker ${worker.result.dispatchId} failed to become ready.`
      const hasNext = index + 1 < candidates.length
      if (hasNext && RETRYABLE_WORKER_START_STAGES.has(worker.result.failedStage ?? '')) {
        failures.push(`${agent}: ${reason}`)
        retryOf = worker.result.dispatchId
        continue
      }
      throw new MissionWorkerStartFailure(reason, allAttemptsHaveNoResidualEffects)
    } catch (error) {
      const hasNext = index + 1 < candidates.length
      if (hasNext && error instanceof RuntimeClientError && error.code === 'agent_unconfigured') {
        allAttemptsHaveNoResidualEffects = false
        failures.push(`${agent}: ${error.message}`)
        continue
      }
      throw error
    }
  }

  throw new RuntimeClientError(
    'mission_worker_start_failed',
    `No mission agent could start task ${taskId}: ${failures.join('; ')}`
  )
}
