// What a person on this computer, its phone, or a window paired to it does about asks from agents
// on servers this computer is paired to: introduce an agent in a server's chat, answer a card, and
// choose the servers that may ask an agent without asking each time.
import { defineMethod, type RpcContext } from '../../core'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { isPersonCaller } from '../orchestration/access/worker-approval-access'
import { pairedServerAsksFor } from '../../../orchestration/federation/paired-server-asks/paired-server-asks-pull'
import { decidePairedServerAsk } from '../../../orchestration/federation/paired-server-asks/paired-server-ask-decisions'
import { safeJson } from '../../../orchestration/federation/paired-server-asks/paired-server-ask-import'
import {
  allowServer,
  listPairedServerAsks,
  listServerAllowances,
  recordIntroduction,
  removeServerAllowance
} from '../../../orchestration/db/federation/paired-server-asks-store'
import { ClientAskPayload } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import {
  PairedServerAllowParams,
  PairedServerAllowancesParams,
  PairedServerAskDecideParams,
  PairedServerAskIntroduceParams,
  PairedServerAskListParams,
  PairedServerDisallowParams
} from '../../../../../shared/rpc-contract/paired-server-asks-params'

function requirePerson(ctx: RpcContext, what: string): void {
  if (!isPersonCaller(ctx)) {
    throw new OrchestrationError(
      'approval_requires_person',
      `Only a person on this computer, its phone or a window paired to it can ${what}.`,
      { effectsApplied: false }
    )
  }
}

/** The server's key, which these choices are kept by; refused while it can't be read. */
async function serverKey(ctx: RpcContext, environmentId: string): Promise<string> {
  const asks = await pairedServerAsksFor(
    ctx.runtime,
    ctx.runtime.getOrchestrationDb(),
    environmentId
  ).catch(() => null)
  if (!asks) {
    throw new OrchestrationError(
      'remote_runtime_unavailable',
      "Can't reach that server yet, or its Orca can't send messages to agents here. Nothing was changed.",
      { effectsApplied: false }
    )
  }
  return asks.serverKey
}

/** Each server's name as this computer's own catalog has it, never as the server reports it. */
async function serverNames(
  ctx: RpcContext,
  environmentIds: readonly string[]
): Promise<Map<string, string | null>> {
  const names = await Promise.all(
    [...new Set(environmentIds)].map(
      async (environmentId) =>
        [
          environmentId,
          await ctx.runtime
            .resolveOrchestrationWorkerServer(environmentId)
            .then((server) => server.name)
            .catch(() => null)
        ] as const
    )
  )
  return new Map(names)
}

export const PAIRED_SERVER_ASKS_METHODS = [
  defineMethod({
    name: 'pairedServerAsks.introduce',
    permission: 'workspace',
    params: PairedServerAskIntroduceParams,
    handler: async (params, ctx) => {
      requirePerson(ctx, 'introduce an agent here to a server chat')
      recordIntroduction(ctx.runtime.getOrchestrationDb(), {
        serverKey: await serverKey(ctx, params.environmentId),
        rootSession: params.rootSession,
        botId: params.botId,
        environmentId: params.environmentId
      })
      ctx.runtime.ensureOrchestrationPeerMailRelay(params.environmentId)
      return { introduced: true }
    }
  }),
  defineMethod({
    name: 'pairedServerAsks.list',
    permission: 'workspace',
    params: PairedServerAskListParams,
    handler: async (params, ctx) => {
      const rows = listPairedServerAsks(ctx.runtime.getOrchestrationDb(), { state: 'card' }).filter(
        (row) => params.botId === undefined || row.bot_id === params.botId
      )
      const names = await serverNames(
        ctx,
        rows.map((row) => row.environment_id)
      )
      // The agent's Home chat, where a phone shows its cards inline.
      const botOf = new Map(ctx.runtime.bots.list().map((bot) => [bot.id, bot]))
      return {
        cards: rows.flatMap((row) => {
          const ask = ClientAskPayload.safeParse(safeJson(row.payload))
          if (!ask.success) {
            return []
          }
          return [
            {
              messageId: row.message_id,
              environmentId: row.environment_id,
              serverName: names.get(row.environment_id) ?? null,
              botId: row.bot_id,
              botName: botOf.get(row.bot_id)?.name ?? null,
              botChatSessionId: botOf.get(row.bot_id)?.chatSessionId ?? null,
              rootSession: row.root_session,
              from: { label: ask.data.senderLabel, sender: ask.data.sender ?? null },
              subject: ask.data.subject,
              body: ask.data.body ?? '',
              createdAt: row.created_at
            }
          ]
        })
      }
    }
  }),
  defineMethod({
    name: 'pairedServerAsks.decide',
    permission: 'workspace',
    params: PairedServerAskDecideParams,
    handler: (params, ctx) => {
      requirePerson(ctx, 'answer a message from an agent on a paired server')
      return { decided: decidePairedServerAsk(ctx.runtime, params.messageId, params.decision) }
    }
  }),
  defineMethod({
    name: 'pairedServerAsks.allowances',
    permission: 'workspace',
    params: PairedServerAllowancesParams,
    handler: async (params, ctx) => {
      const servers = listServerAllowances(ctx.runtime.getOrchestrationDb(), params.botId)
      // Named for a phone, which can't look a server up by this computer's environment id.
      const names = await serverNames(
        ctx,
        servers.map((server) => server.environmentId)
      )
      return {
        servers: servers.map((server) => ({
          ...server,
          serverName: names.get(server.environmentId) ?? null
        }))
      }
    }
  }),
  defineMethod({
    name: 'pairedServerAsks.allow',
    permission: 'workspace',
    params: PairedServerAllowParams,
    handler: async (params, ctx) => {
      requirePerson(ctx, 'let a paired server ask an agent here')
      allowServer(ctx.runtime.getOrchestrationDb(), {
        serverKey: await serverKey(ctx, params.environmentId),
        botId: params.botId,
        environmentId: params.environmentId
      })
      ctx.runtime.ensureOrchestrationPeerMailRelay(params.environmentId)
      return { allowed: true }
    }
  }),
  defineMethod({
    name: 'pairedServerAsks.disallow',
    permission: 'workspace',
    params: PairedServerDisallowParams,
    handler: (params, ctx) => {
      requirePerson(ctx, 'change which paired servers may ask an agent here')
      removeServerAllowance(ctx.runtime.getOrchestrationDb(), params.serverKey, params.botId)
      return { removed: true }
    }
  })
]
