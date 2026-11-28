import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import type { BotComputerAnswer } from '../bots/bot-link-host-reads'
import type { PhoneBot } from '../bots/host-bots-operations'
import type { HomeBots } from '../home/bots/home-bot-rows'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { scopeRpcClientToExecutionHost } from '../worktree/execution-hosts/execution-host-scoped-rpc-client'

/** One bot reachable from the side rail's Items sheet, with the host client and labels its actions need. */
export type RailBotTarget = {
  /** Stable across hosts: `${hostKey}\0${bot.id}`. */
  key: string
  bot: PhoneBot
  client: RpcClient | null
  pairedHostId: string
  executionHost: ExecutionHostId
  hostKey: string
  hostName: string
  online: boolean
}

/** Everything the rail Items button and sheet need: the bots to list, the Needs you badge count, and reachability. */
export type RailBotsSource = {
  targets: readonly RailBotTarget[]
  needsYou: number
  loading: boolean
  online: boolean
  hostName: string
}

function scopedClientFor(
  paired: RpcClient | null,
  executionHost: ExecutionHostId
): RpcClient | null {
  if (!paired) {
    return null
  }
  return executionHost === LOCAL_EXECUTION_HOST_ID
    ? paired
    : scopeRpcClientToExecutionHost(paired, executionHost)
}

/** Projects Home's already-loaded bots across every paired computer and relayed server into rail targets. */
export function homeRailBotsSource(args: {
  bots: HomeBots
  allClients: readonly { hostId: string; client: RpcClient }[]
  hostStates: Readonly<Record<string, ConnectionState>>
  fallbackHostName: string
}): RailBotsSource {
  const { bots, allClients, hostStates, fallbackHostName } = args
  const clientsByHost = new Map(allClients.map((entry) => [entry.hostId, entry.client]))
  const targets: RailBotTarget[] = []
  let anyOnline = false
  let firstHostName = ''
  for (const computer of bots.computers) {
    const hostName = bots.labels.get(computer.key) || fallbackHostName
    if (!firstHostName && hostName) {
      firstHostName = hostName
    }
    const connected = hostStates[computer.pairedHostId] === 'connected'
    const online = connected && computer.mode === 'live'
    if (online) {
      anyOnline = true
    }
    if (computer.answer.kind !== 'bots' || !computer.answer.enabled) {
      continue
    }
    const client = scopedClientFor(
      clientsByHost.get(computer.pairedHostId) ?? null,
      computer.executionHost
    )
    for (const bot of computer.answer.bots) {
      targets.push({
        key: `${computer.key}\0${bot.id}`,
        bot,
        client,
        pairedHostId: computer.pairedHostId,
        executionHost: computer.executionHost,
        hostKey: computer.key,
        hostName,
        online
      })
    }
  }
  const connected = Object.values(hostStates).some((state) => state === 'connected')
  return {
    targets,
    needsYou: bots.needsYou,
    loading: bots.awaiting && targets.length === 0,
    online: anyOnline || connected,
    hostName: firstHostName || fallbackHostName
  }
}

/** Projects a single paired host's deduplicated bot answers (including relayed servers) into rail targets. */
export function hostAnswersToRailBotsSource(args: {
  answers: readonly BotComputerAnswer[]
  client: RpcClient | null
  online: boolean
  hostName: string
  fallbackHostName: string
}): RailBotsSource {
  const { answers, client, online, hostName, fallbackHostName } = args
  const targets: RailBotTarget[] = []
  let needsYou = 0
  for (const entry of answers) {
    if (entry.answer.kind !== 'bots' || !entry.answer.enabled) {
      continue
    }
    for (const count of Object.values(entry.answer.needsYou)) {
      needsYou += count
    }
    const entryHostName =
      entry.executionHost === LOCAL_EXECUTION_HOST_ID
        ? hostName
        : entry.serverLabel || fallbackHostName
    const scopedClient = scopedClientFor(client, entry.executionHost)
    for (const bot of entry.answer.bots) {
      targets.push({
        key: `${entry.key}\0${bot.id}`,
        bot,
        client: scopedClient,
        pairedHostId: entry.pairedHostId,
        executionHost: entry.executionHost,
        hostKey: entry.key,
        hostName: entryHostName,
        online
      })
    }
  }
  return {
    targets,
    needsYou: online ? needsYou : 0,
    loading: false,
    online,
    hostName
  }
}
