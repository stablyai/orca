import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getRequiredWorktreeSelector } from '../selectors'

type ConnectorDelivery = { outcome: string; reason?: string; reopened?: boolean }

export function formatDelivery(delivery: ConnectorDelivery): string {
  if (delivery.reason) {
    return `${delivery.outcome}: ${delivery.reason}`
  }
  return delivery.reopened ? `${delivery.outcome} (reopened the agent)` : delivery.outcome
}

/** `unknown` cannot say whether this call started the agent, so only the definite answers claim it. */
export function formatConnectorStart(initial: ConnectorDelivery): string {
  const prompt = `prompt ${formatDelivery(initial)}`
  if (initial.outcome === 'accepted') {
    return `started; ${prompt}`
  }
  return initial.outcome === 'refused' ? `not started; ${prompt}` : prompt
}

// The host decides whether connectors are on; this only names an older host's refusal.
export async function callConnector<TResult>(
  client: Pick<HandlerContext['client'], 'call'>,
  method: string,
  params: Record<string, unknown>
) {
  try {
    return await client.call<TResult>(method, params)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca host has no connectors. Update Orca on the host and try again.'
      )
    }
    throw error
  }
}

function conversationParams(flags: HandlerContext['flags']) {
  return {
    source: 'dev',
    externalId: getRequiredStringFlag(flags, 'conversation'),
    deliveryId: getRequiredStringFlag(flags, 'delivery-id')
  }
}

export const CONNECTOR_HANDLERS: Record<string, CommandHandler> = {
  'connector start': async ({ flags, client, cwd, json }) => {
    const projectGroupId = getOptionalStringFlag(flags, 'project-group')
    if ((projectGroupId !== undefined) === flags.has('worktree')) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass exactly one of --worktree or --project-group.'
      )
    }
    const name = getOptionalStringFlag(flags, 'name')
    const target = projectGroupId
      ? {
          kind: 'create-folder-workspace',
          create: { projectGroupId, ...(name ? { name } : {}) }
        }
      : {
          kind: 'existing',
          worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
        }
    const result = await callConnector<{ initial: ConnectorDelivery }>(client, 'connector.start', {
      ...conversationParams(flags),
      agent: getRequiredStringFlag(flags, 'agent'),
      prompt: getRequiredStringFlag(flags, 'prompt'),
      target
    })
    printResult(result, json, (value) => formatConnectorStart(value.initial))
  },
  'connector send': async ({ flags, client, json }) => {
    const result = await callConnector<ConnectorDelivery>(client, 'connector.send', {
      ...conversationParams(flags),
      text: getRequiredStringFlag(flags, 'text')
    })
    printResult(result, json, formatDelivery)
  }
}
