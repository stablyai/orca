import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { printOrchestrationResult } from './agent-view'
import { getOptionalJsonFlag, getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { callOrchestrationMutation } from './mutation-request'
import { resolveCoordinatorTerminalHandle, runScopedSessionCaller } from './terminal-identity'

export const ORCHESTRATION_GATE_HANDLERS: Record<string, CommandHandler> = {
  'orchestration gate-create': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{
      gate: { id: string; task_id: string; status: string }
    }>(client, flags, 'orchestration.gateCreate', {
      task: getRequiredStringFlag(flags, 'task'),
      question: getRequiredStringFlag(flags, 'question'),
      options: getOptionalJsonFlag(flags, 'options'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    // The row echoes the question and options the caller just sent.
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, { fields: (value) => gateReceipt(value.gate) })
      return
    }
    printResult(
      result,
      json,
      (value) =>
        `Gate ${value.gate.id} created for task ${value.gate.task_id} [${value.gate.status}]`
    )
  },

  'orchestration gate-resolve': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{
      gate: { id: string; task_id: string; status: string; resolution: string }
    }>(client, flags, 'orchestration.gateResolve', {
      id: getRequiredStringFlag(flags, 'id'),
      resolution: getRequiredStringFlag(flags, 'resolution'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, { fields: (value) => gateReceipt(value.gate) })
      return
    }
    printResult(result, json, (value) => `Gate ${value.gate.id} resolved: ${value.gate.resolution}`)
  },

  'orchestration gate-list': async ({ flags, client, cwd, json }) => {
    const run = getOptionalStringFlag(flags, 'run')
    // Named runs can be inspected without resolving a pane identity.
    const from = run
      ? runScopedSessionCaller(flags)
      : await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      gates: { id: string; task_id: string; question: string; options?: string; status: string }[]
      count: number
      runId?: string
    }>('orchestration.gateList', {
      task: getOptionalStringFlag(flags, 'task'),
      status: getOptionalStringFlag(flags, 'status'),
      run,
      from
    })
    if (!flags.has('full')) {
      // Rows also carry resolutions and timestamps that no next command takes.
      printOrchestrationResult(result, json, {
        fields: (value) => ({
          gates: value.gates.map((gate) => ({
            id: gate.id,
            taskId: gate.task_id,
            status: gate.status,
            question: gate.question,
            options: gate.options && gate.options !== '[]' ? gate.options : undefined
          })),
          runId: value.runId
        })
      })
      return
    }
    printResult(result, json, (value) => {
      if (value.gates.length === 0) {
        return 'No gates found.'
      }
      return value.gates
        .map((gate) => `${gate.id} task=${gate.task_id} [${gate.status}] "${gate.question}"`)
        .join('\n')
    })
  }
}

function gateReceipt(gate: { id: string; task_id: string; status: string }) {
  return { gateId: gate.id, taskId: gate.task_id, status: gate.status }
}
