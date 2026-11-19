import { readWhileBotLinkConnected } from './bot-link-connection-read'
import type { BotLinkOpenTarget } from '../../../src/shared/bots/bot-link-open-target'
import { hostConnectionEpoch, readHostStatusReply } from '../query/host-status-query'
import { readProbedHostStatus } from '../transport/connection/host-status-probe-operations'
import { BOTS_SESSION_LINKS_RUNTIME_CAPABILITY } from '../../../src/shared/bot-runtime-capabilities'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { BotLinkComputerAnswer } from './bot-link-host-reads'
import type { BotSessionLinkTarget } from './bot-link-target'
import type { HostBot } from './host-bots-read'
import { botHomeLinksRead } from './host-bots-operations'
import {
  structuredOpenLocation,
  structuredSessionWorkers
} from '../session/native-chat/agent-session/mobile-structured-session-open-rpc'
import { scopeRpcClientToExecutionHost } from '../worktree/execution-hosts/execution-host-scoped-rpc-client'
import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host/execution-host'

type LocatedBot = {
  computer: BotLinkComputerAnswer
  bot: HostBot
  client: RpcClient
  current: () => boolean
}
export type LocatedBotSession = LocatedBot & {
  authority: BotLinkOpenTarget
  sessionId: string
  worktreeId: string
  itemId?: string
}
type BotSessionLocation =
  | { kind: 'open'; session: LocatedBotSession }
  | { kind: 'home'; home: LocatedBot }
  | { kind: 'update-needed'; home: LocatedBot; servingHost?: true }
  | { kind: 'failed'; home: LocatedBot }

const readOptions = { timeoutMs: 5000, failWhenDisconnected: true, budgetSpansConnect: true }

/** Only paired clients supplied by the host catalog can answer; URL fields never provide a host or credentials. */
export async function locateBotSessionLink(
  target: BotSessionLinkTarget,
  computers: readonly BotLinkComputerAnswer[],
  clientFor: (pairedHostId: string) => RpcClient | null,
  signal?: AbortSignal
): Promise<BotSessionLocation | { kind: 'missing' | 'ambiguous' }> {
  const answers = await Promise.all(
    computers.map(async (computer): Promise<BotSessionLocation | null> => {
      const bot =
        computer.answer.kind === 'bots'
          ? computer.answer.bots.find((bot) => bot.id === target.botId)
          : null
      const paired = clientFor(computer.pairedHostId)
      if (signal?.aborted || !bot || !paired || paired.getState() !== 'connected') {
        return null
      }
      const epoch = hostConnectionEpoch(paired)
      const current = () =>
        !signal?.aborted &&
        clientFor(computer.pairedHostId) === paired &&
        paired.getState() === 'connected' &&
        hostConnectionEpoch(paired) === epoch
      const client =
        computer.executionHost === LOCAL_EXECUTION_HOST_ID
          ? paired
          : scopeRpcClientToExecutionHost(paired, computer.executionHost)
      const home: LocatedBot = { computer, bot, client, current }
      try {
        return await readWhileBotLinkConnected(
          paired,
          async (stageSignal) => {
            const options = {
              ...readOptions,
              signal: stageSignal,
              beforeSend: () => {
                if (!current() || stageSignal.aborted) {
                  throw new Error('Bot link lookup cancelled')
                }
              }
            }
            const serving = readProbedHostStatus(await readHostStatusReply(paired, options))?.status
              ?.capabilities
            if (!current()) {
              return null
            }
            if (!serving) {
              return { kind: 'failed', home }
            }
            if (!serving.includes(BOTS_SESSION_LINKS_RUNTIME_CAPABILITY)) {
              return { kind: 'update-needed', home, servingHost: true }
            }
            const capabilities = readProbedHostStatus(await readHostStatusReply(client, options))
              ?.status?.capabilities
            if (!current()) {
              return null
            }
            if (!capabilities) {
              return { kind: 'failed', home }
            }
            if (!capabilities.includes(BOTS_SESSION_LINKS_RUNTIME_CAPABILITY)) {
              return { kind: 'update-needed', home }
            }
            const reply = botHomeLinksRead.interpret(
              await botHomeLinksRead.request(client, undefined, options)
            )
            if (!current()) {
              return null
            }
            if (!reply.accepted) {
              return { kind: 'failed', home }
            }
            const link = reply.value[bot.folderWorkspaceId]?.find(
              (link) =>
                link.source === target.conversation.source &&
                link.externalId === target.conversation.externalId &&
                link.bot?.botId === bot.id
            )
            if (!link) {
              return { kind: 'home', home }
            }
            let workerDispatchId: string | undefined
            let sessionId = link.sessionId
            let itemId = target.sessionId === sessionId ? target.itemId : undefined
            if (target.sessionId !== sessionId) {
              const workers = structuredSessionWorkers.interpret(
                await structuredSessionWorkers.request(client, { session: sessionId }, options)
              )
              if (!current()) {
                return null
              }
              const worker = workers.workers.find(
                (worker) =>
                  worker.host === 'local' &&
                  worker.chatSessionId === target.sessionId &&
                  worker.worktreeId
              )
              if (worker) {
                workerDispatchId = worker.dispatchId
                sessionId = target.sessionId
                itemId = target.itemId
              }
            }
            const located = structuredOpenLocation.interpret(
              await structuredOpenLocation.request(
                client,
                { address: `orca_session_id:${sessionId}` },
                options
              )
            )
            if (!current()) {
              return null
            }
            const location = located.location
            return location?.kind === 'chat' && location.sessionId === sessionId
              ? {
                  kind: 'open',
                  session: {
                    ...home,
                    authority: {
                      botId: target.botId,
                      conversation: target.conversation,
                      leadSessionId: link.sessionId,
                      sessionId,
                      worktreeId: location.worktreeId,
                      ...(itemId ? { itemId } : {}),
                      ...(workerDispatchId ? { workerDispatchId } : {})
                    },
                    sessionId,
                    worktreeId: location.worktreeId,
                    ...(itemId ? { itemId } : {})
                  }
                }
              : { kind: 'home', home }
          },
          { signal }
        )
      } catch {
        return current() ? { kind: 'failed', home } : null
      }
    })
  )
  const matches = answers.filter(
    (answer): answer is BotSessionLocation =>
      answer !== null && (answer.kind === 'open' ? answer.session : answer.home).current()
  )
  const [match] = matches
  return matches.length === 1 && match
    ? match
    : { kind: matches.length > 1 ? 'ambiguous' : 'missing' }
}
