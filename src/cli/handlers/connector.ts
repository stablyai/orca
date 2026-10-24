import type { CommandHandler, HandlerContext } from '../dispatch'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
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
  params: Record<string, unknown>,
  options?: { timeoutMs: number }
) {
  try {
    return await client.call<TResult>(method, params, options)
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

type ConnectorPrompt = {
  kind: string
  promptId: string
  tool?: string
  summary?: string
  question?: string
  options?: { id: string; label: string }[]
}

/** A kind this CLI does not know reads as one only Orca can answer, as the contract asks. */
export function formatPendingPrompt(prompt: ConnectorPrompt | null): string {
  if (!prompt) {
    return 'no pending prompt'
  }
  const known = prompt.kind === 'approval' || prompt.kind === 'question'
  const head =
    prompt.kind === 'approval'
      ? `approval ${prompt.tool}${prompt.summary ? `: ${prompt.summary}` : ''}`
      : prompt.kind === 'question'
        ? `question: ${prompt.question}`
        : 'unsupported (answer in Orca)'
  const options = known ? (prompt.options ?? []) : []
  return [
    head,
    `  prompt id: ${prompt.promptId}`,
    ...options.map((option) => `  ${option.id}: ${option.label}`)
  ].join('\n')
}

const DEFAULT_WATCH_MS = 30_000

function conversation(flags: HandlerContext['flags']) {
  return { source: 'dev', externalId: getRequiredStringFlag(flags, 'conversation') }
}

function conversationParams(flags: HandlerContext['flags']) {
  return { ...conversation(flags), deliveryId: getRequiredStringFlag(flags, 'delivery-id') }
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
  },
  'connector prompt': async ({ flags, client, json }) => {
    const result = await callConnector<{ prompt: ConnectorPrompt | null }>(
      client,
      'connector.pendingPrompt',
      conversation(flags)
    )
    printResult(result, json, (value) => formatPendingPrompt(value.prompt))
  },
  'connector answer': async ({ flags, client, json }) => {
    const result = await callConnector<ConnectorDelivery>(client, 'connector.answer', {
      ...conversation(flags),
      promptId: getRequiredStringFlag(flags, 'prompt-id'),
      optionId: getRequiredStringFlag(flags, 'option')
    })
    printResult(result, json, formatDelivery)
  },
  'connector cancel': async ({ flags, client, json }) => {
    const result = await callConnector<ConnectorDelivery>(
      client,
      'connector.cancel',
      conversationParams(flags)
    )
    printResult(result, json, formatDelivery)
  },
  'connector watch': async ({ flags, client, json }) => {
    const forMs = getOptionalNonNegativeIntegerFlag(flags, 'for-ms') ?? DEFAULT_WATCH_MS
    const result = await callConnector<{ snapshot: unknown; events: unknown[] }>(
      client,
      'connector.watch',
      { forMs },
      // The host holds the call open for the whole window.
      { timeoutMs: forMs + 15_000 }
    )
    printResult(result, json, (value) =>
      [value.snapshot, ...value.events].map((event) => JSON.stringify(event)).join('\n')
    )
  }
}
