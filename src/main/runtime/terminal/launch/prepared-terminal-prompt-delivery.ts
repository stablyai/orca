import { randomUUID } from 'node:crypto'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { tuiAgentDisplayName } from '../../../../shared/tui-agent-display-names'
import type { PreparedTerminalPrompts } from '../../../daemon/prepared-agent-launch-protocol'
import type {
  PreparedAgentLaunchIdentity,
  PreparedLaunchInputOutcome,
  PreparedPromptConsumer
} from '../../../../shared/prepared-agent-launch'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-types'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'

export function preparedPromptUncertainText(agent: string): string {
  const name = tuiAgentDisplayName(agent) ?? agent
  return `${name} started, but its first prompt may not have been delivered. Check ${name} before sending the prompt again.`
}

// One process is one prompt consumer across reconnects and controller objects; a reused PID only delays demise.
const promptConsumer: PreparedPromptConsumer = { id: randomUUID(), pid: process.pid }
const promptDeliveries = new Map<string, Promise<PreparedLaunchInputOutcome>>()

/** Acquire, then take the exclusive attempt, then write once; a lost reply retries settlement, never input. */
export async function deliverPreparedPrompts(
  identity: PreparedAgentLaunchIdentity,
  terminal: RuntimeTerminalCreate,
  ports: {
    controller: RuntimePtyController
    deliverPrompts: (
      terminal: RuntimeTerminalCreate,
      prompts: PreparedTerminalPrompts
    ) => Promise<boolean>
  }
): Promise<PreparedLaunchInputOutcome | undefined> {
  const { controller } = ports
  if (!controller.preparedAgentLaunch) {
    return undefined
  }
  const consumer = promptConsumer
  let delivery = promptDeliveries.get(identity.operationId)
  if (!delivery) {
    const acquired = await controller.preparedAgentLaunch({
      action: 'claimPrompt',
      identity,
      consumer
    })
    if (!isPreparedTerminalPrompts(acquired)) {
      return undefined
    }
    const granted = await controller.preparedAgentLaunch({
      action: 'claimPrompt',
      identity,
      consumer,
      attempt: true
    })
    if (!isPreparedTerminalPrompts(granted)) {
      return undefined
    }
    delivery = promptDeliveries.get(identity.operationId)
    if (!delivery) {
      // Boolean refusal does not prove nothing was written, so it settles as uncertain.
      delivery = ports.deliverPrompts(terminal, granted).then(
        (written): PreparedLaunchInputOutcome => (written ? 'written' : 'uncertain'),
        (): PreparedLaunchInputOutcome => 'uncertain'
      )
      promptDeliveries.set(identity.operationId, delivery)
    }
  }
  const outcome = await delivery
  await controller.preparedAgentLaunch({ action: 'settlePrompt', identity, consumer, outcome })
  promptDeliveries.delete(identity.operationId)
  return outcome
}

export function forgetPreparedPromptDelivery(operationId: string): void {
  promptDeliveries.delete(operationId)
}

function isPreparedTerminalPrompts(value: unknown): value is PreparedTerminalPrompts {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  for (const key of ['draft', 'followup'] as const) {
    if (!(key in value)) {
      continue
    }
    const prompt = Reflect.get(value, key)
    if (typeof prompt !== 'object' || prompt === null || !isTuiAgent(prompt.agent)) {
      return false
    }
    if (typeof (key === 'draft' ? prompt.content : prompt.prompt) !== 'string') {
      return false
    }
  }
  return true
}
