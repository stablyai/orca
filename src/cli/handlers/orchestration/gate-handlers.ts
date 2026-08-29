import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { callOrchestrationMutation } from './mutation-request'
import {
  resolveCoordinatorTerminalHandle,
  resolveOptionalCoordinatorTerminalHandle
} from './terminal-identity'

export const ORCHESTRATION_GATE_HANDLERS: Record<string, CommandHandler> = {
  'orchestration gate-create': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{
      gate: { id: string; task_id: string; status: string }
    }>(client, flags, 'orchestration.gateCreate', {
      task: getRequiredStringFlag(flags, 'task'),
      question: getRequiredStringFlag(flags, 'question'),
      options: getOptionalStringFlag(flags, 'options'),
      // Why: gates are Run-scoped, so the coordinator handle is the authorized caller identity.
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
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
    printResult(result, json, (value) => `Gate ${value.gate.id} resolved: ${value.gate.resolution}`)
  },

  'orchestration gate-list': async ({ flags, client, cwd, json }) => {
    const run = getOptionalStringFlag(flags, 'run')
    // Why: named runs remain inspectable without a pane; only implicit runs resolve identity.
    const from = run
      ? await resolveOptionalCoordinatorTerminalHandle(flags, cwd, client)
      : await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      gates: { id: string; task_id: string; question: string; status: string }[]
      count: number
      runId?: string
      binding?: { currentConsumer: boolean }
    }>('orchestration.gateList', {
      task: getOptionalStringFlag(flags, 'task'),
      status: getOptionalStringFlag(flags, 'status'),
      run,
      from
    })
    printResult(result, json, (value) => {
      const nonOwnerNotice =
        value.binding?.currentConsumer === false
          ? `Run ${value.runId} is not bound to this terminal; listed read-only. Mutations require the owning coordinator.`
          : undefined
      if (value.gates.length === 0) {
        return nonOwnerNotice ? `${nonOwnerNotice}\nNo gates found.` : 'No gates found.'
      }
      const gates = value.gates
        .map((gate) => `${gate.id} task=${gate.task_id} [${gate.status}] "${gate.question}"`)
        .join('\n')
      return nonOwnerNotice ? `${nonOwnerNotice}\n${gates}` : gates
    })
  }
}
