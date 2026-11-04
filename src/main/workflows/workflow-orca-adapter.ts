import { randomUUID } from 'node:crypto'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { parseMail, parseStartReceipt, record, text } from './workflow-orca-receipts'
import type { WorkflowOrcaAdapter } from './workflow-orca-adapter-contract'

export class WorkflowOrcaCallError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'WorkflowOrcaCallError'
  }
}

/** Every effect goes through the same RPC handlers the `orca` CLI reaches, never around them. */
export function createWorkflowOrcaAdapter(runtime: OrcaRuntimeService): WorkflowOrcaAdapter {
  let dispatcher: RpcDispatcher | null = null
  const call = async (
    method: string,
    params: Record<string, unknown>,
    requestId?: string
  ): Promise<unknown> => {
    dispatcher ??= new RpcDispatcher({ runtime })
    const id = requestId ?? `wf-${randomUUID()}`
    const response = await dispatcher.dispatch(
      {
        id,
        authToken: 'workflow-controller',
        method,
        params,
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        // A stable id makes a replayed mutation return its first receipt instead of acting twice.
        orchestrationRequestId: id,
        compatibilityInvocationId: id
      },
      { caller: { kind: 'local-cli' } }
    )
    if (!response.ok) {
      throw new WorkflowOrcaCallError(method, response.error.code, response.error.message)
    }
    return response.result
  }
  return {
    async createCoordinatorTerminal({ worktreeSelector, title, requestId }) {
      const result = record(
        await call('terminal.create', {
          worktree: worktreeSelector,
          title,
          clientMutationId: requestId,
          presentation: 'background'
        })
      )
      const handle = text(record(result.terminal).handle) ?? text(result.handle)
      if (!handle) {
        throw new WorkflowOrcaCallError(
          'terminal.create',
          'no_handle',
          'Orca created no coordinator terminal handle.'
        )
      }
      return handle
    },
    async createRun({ from, objective, requestId }) {
      const id = text(
        record(record(await call('orchestration.runCreate', { from, objective }, requestId)).run).id
      )
      if (!id) {
        throw new WorkflowOrcaCallError(
          'orchestration.runCreate',
          'no_run',
          'Orca returned no Run id.'
        )
      }
      return id
    },
    async createTask({ from, orcaRunId, spec, title, displayName, requestId }) {
      const result = await call(
        'orchestration.taskCreate',
        { spec, taskTitle: title, displayName, callerTerminalHandle: from, run: orcaRunId },
        requestId
      )
      const id = text(record(record(result).task).id)
      if (!id) {
        throw new WorkflowOrcaCallError(
          'orchestration.taskCreate',
          'no_task',
          'Orca returned no Task id.'
        )
      }
      return id
    },
    async startWorker(args) {
      const result = await call(
        'orchestration.workerStart',
        {
          task: args.orcaTaskId,
          from: args.from,
          run: args.orcaRunId,
          worktree: args.worktree,
          agent: args.agent,
          displayName: args.displayName,
          ...(args.model ? { model: args.model } : {}),
          ...(args.effort ? { effort: args.effort } : {}),
          ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
          ...(args.retryOf ? { retryOf: args.retryOf } : {})
        },
        args.requestId
      )
      const receipt = parseStartReceipt(result)
      // The receipt names no terminal; Orca's worker-dispatch row is where the start recorded it.
      const worker = receipt.orcaDispatchId
        ? runtime.getOrchestrationDb().getWorkerDispatch(receipt.orcaDispatchId)
        : undefined
      return {
        ...receipt,
        terminalHandle: receipt.terminalHandle ?? worker?.agent_terminal_handle ?? null,
        worktreeId: receipt.worktreeId ?? worker?.worktree_id ?? null
      }
    },
    async waitForMail({ from, orcaRunId, ack, timeoutMs }) {
      const result = record(
        await call('orchestration.check', {
          terminal: from,
          run: orcaRunId,
          wait: true,
          timeoutMs,
          ...(ack ? { ack } : {})
        })
      )
      const messages = Array.isArray(result.messages) ? result.messages.map(parseMail) : []
      return { deliveryId: text(result.deliveryId), messages }
    },
    async sendToDispatch({ from, orcaRunId, dispatchId, subject, body, requestId }) {
      const result = record(
        await call(
          'orchestration.send',
          { from, to: `dispatch:${dispatchId}`, subject, body, run: orcaRunId, type: 'status' },
          requestId
        )
      )
      return text(record(result.message).id) ?? text(result.messageId)
    },
    async createGate({ from, orcaRunId, orcaTaskId, question, requestId }) {
      const result = record(
        await call(
          'orchestration.gateCreate',
          {
            task: orcaTaskId,
            question,
            options: JSON.stringify(['approved', 'rejected']),
            from,
            run: orcaRunId
          },
          requestId
        )
      )
      return text(record(result.gate).id) ?? text(result.id)
    },
    async resolveGate({ from, orcaRunId, gateId, resolution, requestId }) {
      await call(
        'orchestration.gateResolve',
        { id: gateId, resolution, from, run: orcaRunId },
        requestId
      )
    },
    async updateTask({ orcaRunId, orcaTaskId, status, result, requestId }) {
      await call(
        'orchestration.taskUpdate',
        { id: orcaTaskId, status, result, run: orcaRunId },
        requestId
      )
    },
    async stopWorker({ dispatchId, requestId }) {
      return (
        text(
          record(await call('orchestration.workerStop', { dispatch: dispatchId }, requestId)).state
        ) ?? 'unknown'
      )
    },
    async reply({ from, orcaRunId, messageId, body, requestId }) {
      await call('orchestration.reply', { id: messageId, body, from, run: orcaRunId }, requestId)
    },
    async rebindRun({ from, orcaRunId, requestId }) {
      await call('orchestration.runUse', { id: orcaRunId, from }, requestId)
    },
    async closeTerminal(handle) {
      await call('terminal.close', { terminal: handle })
    },
    async detectAgents() {
      try {
        const result = await call('preflight.detectAgents', {})
        const list = Array.isArray(result) ? result : record(result).agents
        return Array.isArray(list)
          ? list.flatMap((entry) =>
              typeof entry === 'string'
                ? [entry]
                : text(record(entry).id)
                  ? [String(record(entry).id)]
                  : []
            )
          : null
      } catch {
        return null
      }
    },
    async installedSkills() {
      try {
        const skills = record(await call('skills.discover', {})).skills
        return Array.isArray(skills)
          ? skills.flatMap((skill) => {
              const entry = record(skill)
              return entry.installed === true && typeof entry.name === 'string' ? [entry.name] : []
            })
          : null
      } catch {
        return null
      }
    },
    readTask(orcaTaskId) {
      const task = runtime.getOrchestrationDb().getTask(orcaTaskId)
      return task ? { status: task.status, result: task.result } : null
    },
    readDispatch(orcaDispatchId) {
      const db = runtime.getOrchestrationDb()
      const dispatch = db.getDispatchContextById(orcaDispatchId)
      if (!dispatch) {
        return null
      }
      return {
        status: dispatch.status,
        workerState: db.getWorkerDispatch(orcaDispatchId)?.state ?? null,
        lastFailure: dispatch.last_failure
      }
    },
    terminalExists(handle) {
      return runtime.getTerminalPaneKey(handle) !== null
    },
    paneKeyFor(handle) {
      return runtime.getTerminalPaneKey(handle) ?? null
    }
  }
}
