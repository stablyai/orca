import { randomUUID } from 'node:crypto'
import { RuntimeClientError, RuntimeRpcFailureError } from '../../runtime-client'
import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { SessionLinkSnapshot } from '../../../shared/session-link'

function linkOperationError(error: unknown, guidance: string): Error {
  const message = `${error instanceof Error ? error.message : String(error)}\n${guidance}`
  if (error instanceof RuntimeRpcFailureError) {
    return new RuntimeRpcFailureError({
      ...error.response,
      error: { ...error.response.error, message }
    })
  }
  return error instanceof RuntimeClientError
    ? new RuntimeClientError(error.code, message, error.data)
    : new Error(message)
}

export const ORCHESTRATION_LINK_HANDLERS: Record<string, CommandHandler> = {
  'orchestration link-show': async ({ flags, client, json }) => {
    const result = await client.call('orchestration.linkShow', {
      id: getRequiredStringFlag(flags, 'id')
    })
    printResult(result, json, (value) => JSON.stringify(value, null, 2))
  },
  'orchestration link-send': async ({ flags, client, json }) => {
    const operationId = getOptionalStringFlag(flags, 'operation') ?? randomUUID()
    try {
      const result = await client.call('orchestration.linkSend', {
        id: getRequiredStringFlag(flags, 'id'),
        operationId,
        body: getRequiredStringFlag(flags, 'body'),
        kind: getOptionalStringFlag(flags, 'kind') ?? 'message',
        ...(getOptionalStringFlag(flags, 'reply-to')
          ? { replyTo: getOptionalStringFlag(flags, 'reply-to') }
          : {})
      })
      printResult(
        { ...result, result: { operationId, ...SessionLinkSnapshot.parse(result.result) } },
        json,
        (value) => JSON.stringify(value, null, 2)
      )
    } catch (error) {
      throw linkOperationError(
        error,
        `If delivery is uncertain, retry unchanged with --operation ${operationId}.`
      )
    }
  },
  'orchestration link-control': async ({ flags, client, json }) => {
    const id = getRequiredStringFlag(flags, 'id')
    const action = getRequiredStringFlag(flags, 'action')
    if (action !== 'stop' && action !== 'end') {
      throw new Error('Agents may only stop or end a link.')
    }
    const operationId = getOptionalStringFlag(flags, 'operation') ?? randomUUID()
    try {
      const observed = await client.call('orchestration.linkShow', { id })
      const current = SessionLinkSnapshot.parse(observed.result)
      const result = await client.call('orchestration.linkControl', {
        id,
        action,
        version: current.link.version,
        operationId
      })
      printResult(
        { ...result, result: { operationId, ...SessionLinkSnapshot.parse(result.result) } },
        json,
        (value) => JSON.stringify(value, null, 2)
      )
    } catch (error) {
      throw linkOperationError(error, `Retry unchanged with --operation ${operationId}.`)
    }
  }
}
