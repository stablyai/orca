// A bot link's answers from one paired computer: its own bots, and each server it relays.
import type { BotLinkHostAnswer } from '../../../src/shared/bots/bot-link-resolution'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import { readHostStatusReply, hostConnectionEpoch } from '../query/host-status-query'
import { readProbedHostStatus } from '../transport/connection/host-status-probe-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  relaysToServers,
  scopeRpcClientToExecutionHost
} from '../worktree/execution-hosts/execution-host-scoped-rpc-client'
import { relayHostsListRead } from '../worktree/execution-hosts/server-workspace-operations'
import { hostBotsKey, readHostBots, type HostBotsRead } from './host-bots-read'
import { readWhileBotLinkConnected } from './bot-link-connection-read'
import type { SendRequestOptions } from '../transport/rpc/unvalidated-rpc-request-port'

type BotLinkAnswer = BotLinkHostAnswer['answer'] & { sessionItemLinks?: true }

/** A computer's full read (switch, create, Needs you), as Home lists it. */
export type BotComputerRead = HostBotsRead | Extract<BotLinkAnswer, { kind: 'unreachable' }>

/** One computer a link may open on: `key` is `hostBotsKey` of its paired computer and itself. */
export type BotLinkComputerAnswer<A extends BotLinkAnswer = BotLinkAnswer> = {
  key: string
  pairedHostId: string
  executionHost: ExecutionHostId
  /** A relayed server's name; the paired computer's own name is its profile's. */
  serverLabel?: string
  installationId?: string
  answer: A
}

export type BotComputerAnswer = BotLinkComputerAnswer<BotComputerRead>

/** The paired computer's bots and, through it, each relayed server's; a down server is unreachable. */
export async function readBotLinkComputerAnswers(
  client: RpcClient,
  pairedHostId: string,
  lifetime: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<BotLinkComputerAnswer[]> {
  const epoch = hostConnectionEpoch(client)
  try {
    return await readWhileBotLinkConnected(
      client,
      async (signal) => {
        const options: SendRequestOptions = {
          signal,
          timeoutMs: 5000,
          failWhenDisconnected: true,
          budgetSpansConnect: true,
          beforeSend: () => {
            if (signal.aborted || hostConnectionEpoch(client) !== epoch) {
              throw new Error('Bot link discovery superseded')
            }
          }
        }
        return await readBotComputerAnswers(client, pairedHostId, options)
      },
      { ...lifetime, timeoutMs: lifetime.timeoutMs ?? 10_000 }
    )
  } catch {
    return [
      {
        key: hostBotsKey(pairedHostId),
        pairedHostId,
        executionHost: LOCAL_EXECUTION_HOST_ID,
        answer: { kind: 'unreachable' }
      }
    ]
  }
}

/** One read of a connected paired computer's bots and its relayed servers'; Home and links share it. */
export async function readBotComputerAnswers(
  client: RpcClient,
  pairedHostId: string,
  /** Absent, each list read joins one already out for the same computer. */
  options?: SendRequestOptions
): Promise<BotComputerAnswer[]> {
  const status = await readHostStatusReply(client, options)
    .then((reply) => readProbedHostStatus(reply)?.status ?? null)
    .catch(() => null)
  options?.beforeSend?.()
  const own: BotComputerAnswer = {
    key: hostBotsKey(pairedHostId),
    pairedHostId,
    executionHost: LOCAL_EXECUTION_HOST_ID,
    ...(status?.hostDescriptor?.installationId
      ? { installationId: status.hostDescriptor.installationId }
      : {}),
    answer: status?.capabilities
      ? await readHostBots(client, hostBotsKey(pairedHostId), options)
      : { kind: 'unreadable' }
  }
  if (status !== null && !relaysToServers(client, status.capabilities ?? [])) {
    return [own]
  }
  // Without the computer's status, whether it relays to servers is unknown, as when their list fails.
  options?.beforeSend?.()
  const servers =
    status === null
      ? null
      : await relayHostsListRead
          .request(client, undefined, options)
          .then((reply) => relayHostsListRead.interpret(reply))
          .then((read) => (read.accepted ? read.value : null))
          .catch(() => null)
  options?.beforeSend?.()
  if (servers === null) {
    return [
      own,
      {
        key: hostBotsKey(pairedHostId, 'relay-inventory'),
        pairedHostId,
        executionHost: LOCAL_EXECUTION_HOST_ID,
        answer: { kind: 'unreadable' }
      }
    ]
  }
  const answers = await Promise.all(
    servers.map(async (server): Promise<BotComputerAnswer> => {
      const key = hostBotsKey(pairedHostId, server.hostId)
      const answer: BotComputerRead =
        server.relay === 'ready'
          ? await readHostBots(scopeRpcClientToExecutionHost(client, server.hostId), key, options)
          : server.relay === 'update-needed'
            ? { kind: 'no-capability' }
            : { kind: 'unreachable' }
      return {
        key,
        pairedHostId,
        executionHost: server.hostId,
        serverLabel: server.label,
        ...(server.installationId ? { installationId: server.installationId } : {}),
        answer
      }
    })
  )
  options?.beforeSend?.()
  return [own, ...answers]
}

/** A server paired directly and also relayed is one computer: its direct answer stands. A server
 *  two computers relay is one too: the first relay that lists its bots and can make one there stands,
 *  else the first that lists them, else the first. */
export function withoutRelayedTwins<T extends BotLinkComputerAnswer>(answers: readonly T[]): T[] {
  const direct = new Set(
    answers.flatMap((entry) =>
      entry.executionHost === LOCAL_EXECUTION_HOST_ID && entry.installationId
        ? [entry.installationId]
        : []
    )
  )
  // A relay passes bots.create on only when its own build takes it.
  const relaysCreate = new Set(
    answers.flatMap((entry) =>
      entry.key === hostBotsKey(entry.pairedHostId) &&
      'takesCreate' in entry.answer &&
      entry.answer.takesCreate === true
        ? [entry.pairedHostId]
        : []
    )
  )
  const rank = (entry: T): number =>
    entry.answer.kind !== 'bots'
      ? 0
      : 'takesCreate' in entry.answer &&
          entry.answer.takesCreate === true &&
          relaysCreate.has(entry.pairedHostId)
        ? 2
        : 1
  const chosen = new Map<string, T>()
  for (const entry of answers) {
    const id = entry.installationId
    if (entry.executionHost === LOCAL_EXECUTION_HOST_ID || !id || direct.has(id)) {
      continue
    }
    const kept = chosen.get(id)
    if (!kept || rank(entry) > rank(kept)) {
      chosen.set(id, entry)
    }
  }
  return answers.filter(
    (entry) =>
      entry.executionHost === LOCAL_EXECUTION_HOST_ID ||
      !entry.installationId ||
      chosen.get(entry.installationId) === entry
  )
}
