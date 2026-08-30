import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredFiniteNumber, getRequiredStringFlag } from '../../flags'
import { callOrchestrationMutation } from './mutation-request'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'

type CapacitySnapshot = {
  runId: string
  targetConcurrency: number
  activeCount: number
  availableSlots: number
  launchableCount: number
  launchableTasks: { id: string; display_name?: string | null; task_title?: string | null }[]
  eligiblePendingTaskIds: string[]
  settledTerminalDebt: {
    dispatchId: string
    terminalState: string
    retainedReason: string | null
  }[]
}

function formatCapacity(snapshot: CapacitySnapshot): string {
  const head =
    `Run ${snapshot.runId}: target ${snapshot.targetConcurrency}, active ${snapshot.activeCount}, ` +
    `open ${snapshot.availableSlots}, launchable ${snapshot.launchableCount}`
  const launchable = snapshot.launchableTasks.map((task) => {
    const label = task.display_name ?? task.task_title
    return label ? `${task.id} ${label}` : task.id
  })
  const debt = snapshot.settledTerminalDebt.map(
    (worker) =>
      `${worker.dispatchId} [${worker.terminalState}]${worker.retainedReason ? ` ${worker.retainedReason}` : ''}`
  )
  return [
    head,
    launchable.length > 0
      ? `Eligible ready tasks:\n${launchable.join('\n')}`
      : 'No eligible ready tasks.',
    snapshot.eligiblePendingTaskIds.length > 0
      ? `Eligible but blocked/pending: ${snapshot.eligiblePendingTaskIds.join(', ')}`
      : '',
    debt.length > 0 ? `Settled terminal cleanup:\n${debt.join('\n')}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export const ORCHESTRATION_CAPACITY_HANDLERS: Record<string, CommandHandler> = {
  'orchestration capacity-set': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{ capacity: CapacitySnapshot }>(
      client,
      flags,
      'orchestration.capacityConfigure',
      {
        target: getRequiredFiniteNumber(flags, 'target'),
        run: getOptionalStringFlag(flags, 'run'),
        from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
      }
    )
    printResult(result, json, (value) => formatCapacity(value.capacity))
  },
  'orchestration capacity-show': async ({ flags, client, cwd, json }) => {
    const run = getOptionalStringFlag(flags, 'run')
    const result = await client.call<{ capacity: CapacitySnapshot }>('orchestration.capacityShow', {
      run,
      from: run ? undefined : await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    printResult(result, json, (value) => formatCapacity(value.capacity))
  },
  'orchestration capacity-enroll': async ({ flags, client, cwd, json }) => {
    const task = getRequiredStringFlag(flags, 'task')
    const result = await callOrchestrationMutation<{ task: { id: string } }>(
      client,
      flags,
      'orchestration.capacityTaskSet',
      {
        task,
        eligible: true,
        run: getOptionalStringFlag(flags, 'run'),
        from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
      }
    )
    printResult(result, json, () => `Task ${task} enrolled in the Run capacity pool.`)
  },
  'orchestration capacity-withdraw': async ({ flags, client, cwd, json }) => {
    const task = getRequiredStringFlag(flags, 'task')
    const result = await callOrchestrationMutation<{ task: { id: string } }>(
      client,
      flags,
      'orchestration.capacityTaskSet',
      {
        task,
        eligible: false,
        run: getOptionalStringFlag(flags, 'run'),
        from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
      }
    )
    printResult(result, json, () => `Task ${task} withdrawn from the Run capacity pool.`)
  }
}
