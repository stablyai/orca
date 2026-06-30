import type { ScryerEditLeaseStore } from './edit-lease-store'
import type {
  ModelEditLease,
  ScryerEngine,
  ScryerModelValidateResult,
  ScryerOperationContext,
  ScryerOperationResult,
  ScryerPlanPendingResult
} from './engine'
import {
  evaluateCompletionGate,
  foldInputsFor,
  type CompletionGateResult
} from './edit-session-gate'

export type BeginAgentEditSessionInput = {
  projectPath: string
  agentRunId: string
}

export type EditSessionStarted = {
  projectPath: string
  agentRunId: string
}

export type CompleteAgentEditSessionInput = {
  projectPath: string
  agentRunId: string
  foldPolicy?: 'never' | 'when_gate_passes'
}

export type CancelAgentEditSessionInput = {
  projectPath: string
  agentRunId: string
}

export type ReadEditSessionInput = {
  projectPath: string
}

export type EditSessionLeaseStatus = {
  owner?: ModelEditLease['owner']
  agentRunId?: string
  createdAt?: string
  expiresAt?: string
}

export type EditSessionStatus = {
  projectPath: string
  activeLease: EditSessionLeaseStatus | null
}

export type ScryerEditSessionController = {
  beginAgentEditSession(input: BeginAgentEditSessionInput): Promise<EditSessionStarted>
  completeAgentEditSession(input: CompleteAgentEditSessionInput): Promise<CompletionGateResult>
  cancelAgentEditSession(input: CancelAgentEditSessionInput): Promise<void>
  readEditSession(input: ReadEditSessionInput): Promise<EditSessionStatus>
}

export type ScryerAgentRunStatus = 'running' | 'done' | 'cancelled' | 'crashed'

export type ScryerAgentRunFinishedEvent = {
  agentRunId: string
  status: Exclude<ScryerAgentRunStatus, 'running'>
}

export type ScryerAgentRunRuntime = {
  getRunStatus(agentRunId: string): Promise<ScryerAgentRunStatus>
  onRunFinished(
    agentRunId: string,
    callback: (event: ScryerAgentRunFinishedEvent) => void | Promise<void>
  ): () => void
}

export type CreateScryerEditSessionControllerOptions = {
  engine: ScryerEngine
  leaseStore: ScryerEditLeaseStore
  agentRuntime: ScryerAgentRunRuntime
}

function unwrapOperationResult<T>(result: ScryerOperationResult<T>): T {
  if (result.ok) {
    return result.result
  }
  throw new Error(`${result.operationId} failed: ${result.error.code} ${result.error.message}`)
}

function operationContext(
  projectPath: string,
  agentRunId: string,
  leaseToken?: string
): ScryerOperationContext {
  return {
    transport: 'agent',
    caller: 'agent',
    cwd: projectPath,
    projectRoot: projectPath,
    agentRunId,
    ...(leaseToken ? { leaseToken } : {})
  }
}

function toLeaseStatus(lease: ModelEditLease | null): EditSessionLeaseStatus | null {
  if (!lease) {
    return null
  }
  return {
    ...(lease.owner ? { owner: lease.owner } : {}),
    ...(lease.agentRunId ? { agentRunId: lease.agentRunId } : {}),
    ...(lease.createdAt ? { createdAt: lease.createdAt } : {}),
    ...(lease.expiresAt ? { expiresAt: lease.expiresAt } : {})
  }
}

export function createScryerEditSessionController(
  options: CreateScryerEditSessionControllerOptions
): ScryerEditSessionController {
  const subscriptions = new Map<string, () => void>()

  function sessionKey(projectPath: string, agentRunId: string): string {
    return `${projectPath}\u0000${agentRunId}`
  }

  async function cleanupSession(projectPath: string, agentRunId: string): Promise<void> {
    await options.leaseStore.release({ projectPath, agentRunId })
    const key = sessionKey(projectPath, agentRunId)
    subscriptions.get(key)?.()
    subscriptions.delete(key)
  }

  const controller: ScryerEditSessionController = {
    async beginAgentEditSession(input) {
      const status = await options.agentRuntime.getRunStatus(input.agentRunId)
      if (status !== 'running') {
        throw new Error(`Cannot begin Scryer edit session for agent run in '${status}' state`)
      }
      const acquired = await options.leaseStore.acquire({
        projectPath: input.projectPath,
        owner: 'agent',
        agentRunId: input.agentRunId
      })
      if (!acquired.ok) {
        throw new Error(
          `Cannot begin Scryer edit session; active lease belongs to ${
            acquired.activeLease.agentRunId ?? acquired.activeLease.owner ?? 'another owner'
          }`
        )
      }
      const key = sessionKey(input.projectPath, input.agentRunId)
      subscriptions.get(key)?.()
      subscriptions.set(
        key,
        options.agentRuntime.onRunFinished(input.agentRunId, async (event) => {
          if (event.status === 'done') {
            await controller.completeAgentEditSession({
              projectPath: input.projectPath,
              agentRunId: input.agentRunId
            })
            return
          }
          await controller.cancelAgentEditSession({
            projectPath: input.projectPath,
            agentRunId: input.agentRunId
          })
        })
      )
      return {
        projectPath: input.projectPath,
        agentRunId: input.agentRunId
      }
    },
    async completeAgentEditSession(input) {
      const status = await options.agentRuntime.getRunStatus(input.agentRunId)
      if (status !== 'done') {
        throw new Error(`Cannot complete Scryer edit session for agent run in '${status}' state`)
      }
      const activeLease = await options.leaseStore.read({ projectPath: input.projectPath })
      const context = operationContext(input.projectPath, input.agentRunId, activeLease?.token)
      try {
        const pending = unwrapOperationResult(
          await options.engine.executeOperation<ScryerPlanPendingResult>(
            'scryer.plan.pending',
            {},
            context
          )
        )
        const validation = unwrapOperationResult(
          await options.engine.executeOperation<ScryerModelValidateResult>(
            'scryer.model.validate',
            {},
            context
          )
        )
        const gate = evaluateCompletionGate({
          pending,
          validation,
          activeLease,
          agentRunId: input.agentRunId
        })
        if (input.foldPolicy === 'when_gate_passes' && gate.foldAllowed) {
          for (const foldInput of foldInputsFor(gate.pending.changes)) {
            unwrapOperationResult(
              await options.engine.executeOperation('scryer.plan.fold', foldInput, context)
            )
          }
        }
        return gate
      } finally {
        await cleanupSession(input.projectPath, input.agentRunId)
      }
    },
    async cancelAgentEditSession(input) {
      await cleanupSession(input.projectPath, input.agentRunId)
    },
    async readEditSession(input) {
      return {
        projectPath: input.projectPath,
        activeLease: toLeaseStatus(
          await options.leaseStore.read({ projectPath: input.projectPath })
        )
      }
    }
  }

  return controller
}
