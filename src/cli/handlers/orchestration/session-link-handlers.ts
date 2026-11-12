import { randomUUID } from 'node:crypto'
import { RuntimeClientError, RuntimeRpcFailureError } from '../../runtime-client'
import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../command-result-output'
import { getOptionalStringFlag, getOptionalJsonFlag, getRequiredStringFlag } from '../../flags'
import { sessionLinkSendReceipt } from '../../../shared/session-link-receipt'
import {
  SessionLinkSnapshot,
  LinkSendParams,
  SESSION_LINK_OWNER_CHOICES_CAPABILITY,
  SESSION_LINK_GROUP_CAPABILITY
} from '../../../shared/session-link'
import type { RuntimeStatus } from '../../../shared/runtime-types'

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

async function linkGroupSupport(
  client: Parameters<CommandHandler>[0]['client']
): Promise<{ groupSupport?: true }> {
  const status = await client.call<RuntimeStatus>('status.get')
  return status.result.capabilities?.includes(SESSION_LINK_GROUP_CAPABILITY)
    ? { groupSupport: true }
    : {}
}

export const ORCHESTRATION_LINK_HANDLERS: Record<string, CommandHandler> = {
  'orchestration link-show': async ({ flags, client, json }) => {
    const result = await client.call('orchestration.linkShow', {
      id: getRequiredStringFlag(flags, 'id'),
      ...(await linkGroupSupport(client))
    })
    printResult(result, json, (value) => JSON.stringify(value, null, 2))
  },
  'orchestration link-send': async ({ flags, client, json }) => {
    const operationId = getOptionalStringFlag(flags, 'operation') ?? randomUUID()
    try {
      const choicesJson = getOptionalJsonFlag(flags, 'choices-json')
      const allowOther = getOptionalStringFlag(flags, 'allow-other')
      if (allowOther !== undefined && allowOther !== 'true' && allowOther !== 'false') {
        throw new Error('--allow-other must be true or false.')
      }
      const params = LinkSendParams.parse({
        id: getRequiredStringFlag(flags, 'id'),
        operationId,
        body: getRequiredStringFlag(flags, 'body'),
        kind: getOptionalStringFlag(flags, 'kind') ?? 'message',
        ...(getOptionalStringFlag(flags, 'to') ? { to: getOptionalStringFlag(flags, 'to') } : {}),
        ...(choicesJson ? { choices: JSON.parse(choicesJson) } : {}),
        ...(allowOther !== undefined ? { allowOther: allowOther === 'true' } : {}),
        ...(getOptionalStringFlag(flags, 'reply-to')
          ? { replyTo: getOptionalStringFlag(flags, 'reply-to') }
          : {})
      })
      if (params.choices || params.allowOther !== undefined) {
        const status = await client.call<RuntimeStatus>('status.get')
        if (!status.result.capabilities?.includes(SESSION_LINK_OWNER_CHOICES_CAPABILITY)) {
          // Older hosts reject extra fields; preserve the choices in their free-text question.
          params.body = `${params.body}\n\n${(params.choices ?? [])
            .map(
              (choice, index) =>
                `${index + 1}. ${choice.label}${choice.description ? ` — ${choice.description}` : ''}`
            )
            .join('\n')}`
          delete params.choices
          delete params.allowOther
        }
      }
      const group = await linkGroupSupport(client)
      if (params.to && !group.groupSupport) {
        throw new Error('Update the host to address participants in a group link.')
      }
      const result = await client.call('orchestration.linkSend', { ...params, ...group })
      const snapshot = SessionLinkSnapshot.parse(result.result)
      printResult(
        {
          ...result,
          result: {
            operationId,
            delivery: sessionLinkSendReceipt(snapshot, operationId),
            ...snapshot
          }
        },
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
    const summary = getOptionalStringFlag(flags, 'summary')
    if (summary && action !== 'end') {
      throw new Error('A closing summary requires --action end.')
    }
    const callerOperationId = getRequiredStringFlag(flags, 'turn-operation')
    const operationId = getOptionalStringFlag(flags, 'operation') ?? randomUUID()
    try {
      const group = await linkGroupSupport(client)
      const observed = await client.call('orchestration.linkShow', { id, ...group })
      const current = SessionLinkSnapshot.parse(observed.result)
      const result = await client.call('orchestration.linkControl', {
        id,
        action,
        callerOperationId,
        ...(summary ? { summary } : {}),
        version: current.link.version,
        ...group,
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
