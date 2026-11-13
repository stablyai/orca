import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { gateCreateAccess, gateResolveAccess, inspectedRunAccess } from '../access/run-access-rules'
import type { GateStatus } from '../../../../orchestration/db/orchestration-records'
import { Coordinator } from '../../../../orchestration/coordinator/coordinator'
import {
  GateCreateParams,
  GateListParams,
  GateResolveParams,
  RunParams,
  RunStopParams
} from '../../../../../../shared/rpc-contract/orchestration/orchestration-gates-params'

// Keep one coordinator reference for runStop; the DB allows only one active run.
let activeCoordinator: Coordinator | null = null

export const ORCHESTRATION_GATE_METHODS = [
  // Return the run id immediately; callers query persisted progress while coordination runs in the background.
  defineOrchestrationMethod({
    name: 'orchestration.run',
    permission: 'workspace',
    params: RunParams,
    access: { kind: 'localOnly', targets: {} },
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()

      const existing = db.getActiveCoordinatorRun()
      if (existing) {
        throw new Error(`Coordinator already running: ${existing.id}`)
      }

      const coordinatorHandle = params.from ?? 'coordinator'
      const coordinator = new Coordinator(db, runtime, {
        spec: params.spec,
        coordinatorHandle,
        pollIntervalMs: params.pollIntervalMs,
        maxConcurrent: params.maxConcurrent,
        worktree: params.worktree
      })

      activeCoordinator = coordinator

      const run = db.createCoordinatorRun({
        spec: params.spec,
        coordinatorHandle,
        pollIntervalMs: params.pollIntervalMs
      })

      // Do not await the loop; results persist for taskList/runStatus.
      coordinator.runFromExistingRun(run.id).finally(() => {
        if (activeCoordinator === coordinator) {
          activeCoordinator = null
        }
      })

      return { runId: run.id, status: 'running' }
    }
  }),

  defineOrchestrationMethod({
    name: 'orchestration.runStop',
    permission: 'workspace',
    params: RunStopParams,
    access: { kind: 'localOnly', targets: {} },
    handler: (_params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const run = db.getActiveCoordinatorRun()
      if (!run) {
        throw new Error('No active coordinator run')
      }

      if (activeCoordinator) {
        activeCoordinator.stop()
        activeCoordinator = null
      }

      return { runId: run.id, stopped: true }
    }
  }),

  defineOrchestrationMethod({
    name: 'orchestration.gateCreate',
    permission: 'workspace',
    params: GateCreateParams,
    access: {
      kind: 'localOnly',
      caller: 'from',
      targets: { task: 'task', run: 'run' },
      rule: gateCreateAccess
    },
    handler: (params, { runtime }, { options }) => {
      const db = runtime.getOrchestrationDb()
      const gate = db.createGate({
        taskId: params.task,
        question: params.question,
        options
      })
      return { gate }
    }
  }),

  defineOrchestrationMethod({
    name: 'orchestration.gateResolve',
    permission: 'workspace',
    params: GateResolveParams,
    access: {
      kind: 'writes',
      caller: 'from',
      targets: { id: 'gate', run: 'run' },
      rule: gateResolveAccess
    },
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const gate = db.resolveGate(params.id, params.resolution)
      if (!gate) {
        throw new Error(`Gate not found: ${params.id}`)
      }
      return { gate }
    }
  }),

  // Match taskList: an explicit Run is inspectable; absence means the caller's own.
  defineOrchestrationMethod({
    name: 'orchestration.gateList',
    permission: 'workspace',
    params: GateListParams,
    access: {
      kind: 'reads',
      caller: 'from',
      targets: { task: 'task', run: 'run' },
      collection: true,
      rule: inspectedRunAccess
    },
    handler: (params, { runtime }, { run }) => {
      const db = runtime.getOrchestrationDb()
      const gates = db
        .listGates({
          taskId: params.task,
          status: params.status as GateStatus
        })
        .filter((gate) => gate.run_id === run.id)
      return { runId: run.id, gates, count: gates.length }
    }
  })
]
