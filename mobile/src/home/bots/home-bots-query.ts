import type { BotChangeKind } from '../../../../src/shared/bots/bot-change-scope'
import type { BotGroup } from '../../../../src/shared/bots/bot-group-schema'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../src/shared/execution-host/execution-host'
import { readBotComputerAnswers, type BotComputerAnswer } from '../../bots/bot-link-host-reads'
import { readHostAccessRequests } from '../../bots/bot-access-request-operations'
import type { ConnectorAccessRequest } from '../../../../src/shared/connector-bot-access-contract'
import { scopeRpcClientToExecutionHost } from '../../worktree/execution-hosts/execution-host-scoped-rpc-client'
import { groupList } from '../../bots/bot-group-operations'
import { hostBotsKey } from '../../bots/host-bots-read'
import type { NO_HOST_LIST_INPUT } from '../../host-screen/catalog/host-list-queries'
import { defineHostQuery } from '../../query/host-query'
import { ReadCrossedReconnectError } from '../../query/host-query-errors'
import { hostConnectionEpoch } from '../../query/host-status-query'

// One botsChanged burst reads once.
const HOME_BOTS_REFRESH_FLOOR_MS = 3000
// A row's dot and line come from Home's worktree read, so a pane's turn needs no list read.
const LINE_ONLY_KINDS: ReadonlySet<BotChangeKind> = new Set([
  'status',
  'chats',
  'workers',
  'threads'
])

/** A paired computer's own bots and each server's it relays, and its group rooms, read on one connection. */
export type HomeComputerBots = {
  answers: readonly BotComputerAnswer[]
  /** The paired computer's rooms; null when unknown (not read, or the read failed), so the last ones stand. */
  groups: readonly BotGroup[] | null
  /** Each answer's waiting access requests, by its key, as the Bots list counts them; absent unread. */
  accessRequests: Readonly<Record<string, readonly ConnectorAccessRequest[]>>
  /** The connection every answer came over: Needs you counts are live only on that one. */
  epoch: string
  readAt: number
}

export const homeBotsQuery = defineHostQuery<typeof NO_HOST_LIST_INPUT, HomeComputerBots>({
  family: 'bots.home',
  // No options, so the paired computer's list read joins the worktree read's (home-host-worktree-fetch).
  fetch: async (client, _target, _input, _previous, { hostId }) => {
    const epoch = hostConnectionEpoch(client)
    const answers = await readBotComputerAnswers(client, hostId)
    const own = answers.find((entry) => entry.key === hostBotsKey(hostId, LOCAL_EXECUTION_HOST_ID))
    // Rooms are unknown (null) unless read, or none because the computer's Bots switch is off.
    const groups =
      own?.answer.kind !== 'bots'
        ? null
        : own.answer.enabled
          ? groupList
              .request(client, undefined)
              .then((reply) => groupList.interpret(reply).groups)
              .catch(() => null)
          : []
    // As the Bots list: a computer with bots on and some to ask for is asked its access requests.
    const access = Promise.all(
      answers.map(async (entry) =>
        entry.answer.kind === 'bots' && entry.answer.enabled && entry.answer.bots.length > 0
          ? ([
              entry.key,
              await readHostAccessRequests(
                entry.executionHost === LOCAL_EXECUTION_HOST_ID
                  ? client
                  : scopeRpcClientToExecutionHost(client, entry.executionHost)
              )
            ] as const)
          : null
      )
    )
    const [rooms, asked] = await Promise.all([groups, access])
    // A read that spans a reconnect mixes two connections' counts; it reads again on the newest one.
    if (hostConnectionEpoch(client) !== epoch) {
      throw new ReadCrossedReconnectError()
    }
    const accessRequests = Object.fromEntries(
      asked.flatMap((read) => (read?.[1] ? [[read[0], read[1]]] : []))
    )
    return { answers, groups: rooms, accessRequests, epoch, readAt: Date.now() }
  },
  staleTime: HOME_BOTS_REFRESH_FLOOR_MS,
  // Home stays mounted for the whole launch; its bots must not empty while it sits under a screen.
  gcTime: Infinity,
  refetchOnWindowFocus: true,
  signal: {
    // A relayed server coming or going changes which bots list and which take a new one.
    events: ['botsChanged', 'relayHostsChanged'],
    floorMs: HOME_BOTS_REFRESH_FLOOR_MS,
    matches: (event) =>
      event.type !== 'botsChanged' ||
      !event.kinds ||
      event.kinds.some((kind) => !LINE_ONLY_KINDS.has(kind))
  }
})
