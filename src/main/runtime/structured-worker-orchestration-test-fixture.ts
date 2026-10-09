import { vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { OrchestrationDb } from './orchestration/db'
import { eraseRpcMethods } from './rpc/core'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'
import type { StructuredWorkerIdentity } from './structured-worker-identity'

export const LOCAL_SCOPE = { kind: 'local', hostId: 'local' } as const

/** Exposes the real runtime's protected mail resolver to the fixture. */
export class RuntimeProbe extends OrcaRuntimeService {
  withDb(db: OrchestrationDb | null): this {
    this._orchestrationDb = db
    return this
  }

  mailTarget(mailboxHandle: string): unknown {
    return this.resolveStructuredMailboxTarget(mailboxHandle)
  }
}

export function startWorkerDispatch(
  db: OrchestrationDb,
  identity: StructuredWorkerIdentity,
  runtimeEpoch?: string
): string {
  const runId = db.createRun({
    objective: 'cleared worker',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  }).id
  const task = db.createTask({ runId, spec: 'work' })
  const { dispatch } = db.createStartingWorkerDispatch({
    taskId: task.id,
    startOptions: {},
    creator: { kind: 'system' },
    maxDepth: 9,
    ...(runtimeEpoch ? { runtimeEpoch } : {})
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: identity.handle,
    paneKey: identity.paneKey,
    processIncarnation: identity.processIncarnation,
    worktreeId: 'wt_1',
    effects: [],
    setupState: 'not_configured',
    hostScope: JSON.stringify(LOCAL_SCOPE),
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(dispatch.id)
  return dispatch.id
}

export function rpcRuntime(db: OrchestrationDb): {
  runtime: OrcaRuntimeService
  call: (name: string, params: Record<string, unknown>) => Promise<unknown>
} {
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
  return {
    runtime,
    call: async (name, params) => {
      const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
        (candidate) => candidate.name === name
      )
      if (!method?.params) {
        throw new Error(`Method not found: ${name}`)
      }
      return method.handler(method.params.parse(params), { runtime })
    }
  }
}
