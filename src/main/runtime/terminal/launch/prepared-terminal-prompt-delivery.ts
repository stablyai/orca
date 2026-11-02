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

// One process is one prompt consumer; its PID lets the daemon prove a dead writer's attempt uncertain.
const promptConsumer: PreparedPromptConsumer = { id: randomUUID(), pid: process.pid }
// Settlements whose reply was lost, retried by the next publication. Losing this never permits a write.
const unsettled = new Map<string, { attempt: string; outcome: PreparedLaunchInputOutcome }>()

/**
 * The daemon grants the write once per operation; this only reads, asks, writes and settles.
 * Its outcome is read back from the daemon's receipt, never from this call.
 */
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
): Promise<void> {
  const request = ports.controller.preparedAgentLaunch
  if (!request) {
    return
  }
  const settle = async (attempt: string, outcome: PreparedLaunchInputOutcome) => {
    unsettled.set(identity.operationId, { attempt, outcome })
    await request({ action: 'settlePrompt', identity, attempt, outcome })
    unsettled.delete(identity.operationId)
  }
  const owed = unsettled.get(identity.operationId)
  if (owed) {
    await settle(owed.attempt, owed.outcome)
    return
  }
  // A lost reply here consumed nothing: the next publication reads again.
  if (
    !grantedPrompts(await request({ action: 'claimPrompt', identity, consumer: promptConsumer }))
  ) {
    return
  }
  const attempt = randomUUID()
  let granted: unknown
  try {
    granted = await request({ action: 'claimPrompt', identity, consumer: promptConsumer, attempt })
  } catch (error) {
    // This request ended without writing; if it won the grant, that grant closes as uncertain.
    await settle(attempt, 'uncertain').catch(() => {})
    throw error
  }
  const prompts = grantedPrompts(granted)
  if (!prompts) {
    return
  }
  // Boolean refusal does not prove nothing was written, so it settles as uncertain.
  const outcome = await ports.deliverPrompts(terminal, prompts).then(
    (written): PreparedLaunchInputOutcome => (written ? 'written' : 'uncertain'),
    (): PreparedLaunchInputOutcome => 'uncertain'
  )
  await settle(attempt, outcome)
}

export function forgetPreparedPromptDelivery(operationId: string): void {
  unsettled.delete(operationId)
}

function grantedPrompts(value: unknown): PreparedTerminalPrompts | null {
  if (typeof value !== 'object' || value === null || !('prompts' in value)) {
    return null
  }
  return isPreparedTerminalPrompts(value.prompts) ? value.prompts : null
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
