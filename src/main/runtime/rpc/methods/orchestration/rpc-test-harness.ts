import { vi } from 'vitest'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { isStreamingMethod, eraseRpcMethods, type RpcContext, type RpcMethod } from '../../core'
import { OrchestrationDb } from '../../../orchestration/db'
import { OrcaRuntimeService } from '../../../orca-runtime'
import type { TerminalHandleRecord } from '../../../runtime-terminal-contracts'

class OrchestrationRpcRuntime extends OrcaRuntimeService {
  seedTerminalHandle(handle: string, record: TerminalHandleRecord): void {
    this.terminalIdentity.setHandle(handle, record)
  }
}

export const COORDINATOR_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

export type OrchestrationRpcState = {
  db: OrchestrationDb
  runtime: OrchestrationRpcRuntime
  ctx: RpcContext
  activeRunId: string | undefined
}

/** Per-file instance of the shared orchestration RPC fixture: in-memory DB, spied runtime, run scoping. */
export function createOrchestrationRpcHarness() {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrchestrationRpcRuntime
  let activeRunId: string | undefined
  let databasePath = ':memory:'

  const coordinatorPaneKey = COORDINATOR_PANE_KEY

  function setup(
    withBoundRun = true,
    store: ConstructorParameters<typeof OrcaRuntimeService>[0] = null,
    path = ':memory:'
  ): OrchestrationRpcState {
    databasePath = path
    db = new OrchestrationDb(path)
    dbOpen = true
    runtime = new OrchestrationRpcRuntime(store)
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : null
    )
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      runtime.getTerminalPaneKey(handle)
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle.startsWith('term_') ? `runtime_test:${handle}:1` : null
    )
    if (withBoundRun) {
      activeRunId = db.createRun({
        objective: 'Test Run',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey
      }).id
      // Default fixtures to the current contract; test legacy behavior explicitly.
      const createTask = db.createTask.bind(db)
      db.createTask = (task) => createTask({ ...task, runId: task.runId ?? activeRunId })
      const insertMessage = db.insertMessage.bind(db)
      db.insertMessage = (message) =>
        insertMessage({ ...message, runId: message.runId ?? activeRunId })
    } else {
      activeRunId = undefined
    }
    return { db, runtime, ctx: { runtime }, activeRunId }
  }

  function cleanup(): void {
    if (!dbOpen) {
      return
    }
    const currentDb = db
    // Parser-only tests skip setup; cleanup must not reuse the previous test's closed DB.
    dbOpen = false
    currentDb.close()
  }

  function findMethod(name: string): RpcMethod {
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find((m) => m.name === name)
    if (!method || isStreamingMethod(method)) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  // Read ctx per call because tests rebind it.
  async function call(name: string, params: Record<string, unknown>, ctx: RpcContext) {
    const method = findMethod(name)
    const scopedParams = { ...params }
    if (activeRunId) {
      if (name === 'orchestration.taskCreate' || name === 'orchestration.taskUpdate') {
        scopedParams.run ??= activeRunId
        scopedParams.callerTerminalHandle ??= 'term_coord'
      } else if (name === 'orchestration.taskList') {
        scopedParams.run ??= activeRunId
      } else if (name === 'orchestration.dispatch') {
        scopedParams.run ??= activeRunId
        scopedParams.from ??= 'term_coord'
      } else if (
        name === 'orchestration.gateCreate' ||
        name === 'orchestration.gateResolve' ||
        name === 'orchestration.gateList'
      ) {
        // Omit explicit run to exercise gate lookup from the sender's binding.
        scopedParams.from ??= 'term_coord'
      }
    }
    const parsed = method.params ? method.params.parse(scopedParams) : undefined
    return method.handler(parsed, ctx)
  }

  function reopenDatabase(): OrchestrationDb {
    db.close()
    db = new OrchestrationDb(databasePath)
    runtime.setOrchestrationDb(db)
    return db
  }

  return { coordinatorPaneKey, setup, cleanup, findMethod, call, reopenDatabase }
}
