import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isNativeLocalLocation } from '../../shared/execution-host/execution-host'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import {
  hasSlackExecutionSendAuthority,
  isValidSlackExecutionId,
  type SlackExecutionSend
} from '../native-chat/agent-session-wire/operations/slack-execution-authority'
import { SlackExecutionBinding } from './slack-execution-binding'
import { BotsDbWorkerClient } from './db-worker/bots-db-worker-client'
import type { StructuredAgentSessionRuntimeDeps } from '../runtime/agent-session/installation/structured-agent-session-runtime-contract'
import { quotedBotMemory } from './bot-preamble'
import { createSlackRequesterMemory } from './slack-requester-memory'

type ExecutionRecord = Pick<
  AgentSessionRecord,
  'sessionId' | 'location' | 'provider' | 'forkedFrom' | 'providerHandleChain'
>

export function createSlackScopedExecutions(
  memoryRoot: () => string,
  worker: Pick<BotsDbWorkerClient, 'call'>
) {
  const call = (op: string, ...args: unknown[]) =>
    worker.call('slack-executions', join(memoryRoot(), 'executions.sqlite'), op, args)

  async function bindingFor(record: ExecutionRecord): Promise<SlackExecutionBinding> {
    if (
      !isValidSlackExecutionId(record.sessionId) ||
      record.provider !== 'codex' ||
      !isNativeLocalLocation(record.location) ||
      record.location.workspaceKind !== 'folder' ||
      record.forkedFrom ||
      record.providerHandleChain.some(({ origin }) => origin === 'adopted' || origin === 'forked')
    ) {
      throw new Error('Slack execution requires its own local Codex conversation')
    }
    const binding = SlackExecutionBinding.parse(await call('read', record.sessionId))
    if (binding.workspaceId !== record.location.workspaceId) {
      throw new Error('Slack execution workspace does not match its binding')
    }
    return binding
  }
  return {
    async reserve(sessionId: string, binding: SlackExecutionBinding) {
      if (!isValidSlackExecutionId(sessionId)) {
        throw new Error('Expected a reserved Slack execution ID')
      }
      await call('reserve', sessionId, binding)
    },
    async forLaunch(record: ExecutionRecord) {
      const { requester, botId } = await bindingFor(record)
      const root = memoryRoot()
      const memory = createSlackRequesterMemory(join(root, 'memory'), async (path, content) => {
        await call('writeMemory', path, content)
      }).bind(requester && { botId, ...requester })
      return {
        memory,
        ...(requester ? { toolMemory: memory } : {}),
        launchDirectory: async () => {
          const directory = join(root, 'executions', record.sessionId)
          await mkdir(directory, { recursive: true, mode: 0o700 })
          return directory
        },
        instructions: async () => {
          const line =
            'Answer the Slack request in this conversation. The final reply goes to its original Slack thread.'
          if (!requester) {
            return line
          }
          const { index } = await memory.read()
          return index ? `${line}\n\n${quotedBotMemory(index)}` : line
        }
      }
    },
    async allowsSend(record: ExecutionRecord, params: SlackExecutionSend): Promise<boolean> {
      if (
        !hasSlackExecutionSendAuthority(params) ||
        params.envelope.sessionId !== record.sessionId
      ) {
        return false
      }
      try {
        const binding = await bindingFor(record)
        const { body } = params
        const stamp = body.connectorDelivery
        const requester = body.asker?.slackRequester
        return (
          params.delivery === 'queue-if-active' &&
          params.envelope.clientOperationId === binding.operationId &&
          body.role === 'user' &&
          body.origin === 'connector' &&
          !body.from &&
          !body.command &&
          stamp?.account === binding.reply.account &&
          stamp.deliveryId === binding.reply.deliveryId &&
          stamp.conversation.source === binding.reply.conversation.source &&
          stamp.conversation.externalId === binding.reply.conversation.externalId &&
          requester?.teamId === binding.requester?.teamId &&
          requester?.userId === binding.requester?.userId &&
          (!requester ||
            (body.asker?.source === 'slack' &&
              body.asker.userId === requester.userId &&
              !body.asker.app &&
              !body.asker.via))
        )
      } catch {
        return false
      }
    }
  }
}

export type SlackScopedExecutions = ReturnType<typeof createSlackScopedExecutions>

const slackExecutionWorker = new BotsDbWorkerClient()

export function runtimeSlackScopedExecutions() {
  return createSlackScopedExecutions(
    () => join(getCanonicalUserDataPath(), 'slack-requester-memory'),
    slackExecutionWorker
  )
}

export function slackScopedExecutionHostDeps(): Pick<
  StructuredAgentSessionRuntimeDeps,
  'resolveSlackExecutionLaunch' | 'allowsSlackExecutionSend'
> {
  const slack = runtimeSlackScopedExecutions()
  return {
    resolveSlackExecutionLaunch: async (record) => {
      const { launchDirectory, instructions, toolMemory } = await slack.forLaunch(record)
      return { launchDirectory, instructions, ...(toolMemory ? { memory: toolMemory } : {}) }
    },
    allowsSlackExecutionSend: slack.allowsSend
  }
}
