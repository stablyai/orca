import * as z from 'zod'
import { structuredAgentSessionPaneKey } from '../../../src/shared/agent-session/view/structured-agent-session-projection'
import { CommanderChatOpenResult } from '../../../src/shared/rpc-contract/commander-chat'
import { botHomeWorktreeId } from '../bots/host-bots-read'
import { openMobileStructuredSession } from '../session/native-chat/agent-session/open-mobile-structured-session'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { defineRpcOperation, runRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'

const commanderOpen = defineRpcOperation({
  name: 'commander-chat.open',
  method: 'commanderChat.open',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('commander', CommanderChatOpenResult)
})
const homeChatOpen = defineRpcOperation({
  name: 'commander-chat.open-home',
  method: 'bots.chat.open',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('home-session', z.object({ sessionId: z.string().min(1) }))
})

export async function openCommanderHome(client: RpcClient, signal: AbortSignal) {
  const generation = client.getGeneration?.()
  const current = () =>
    !signal.aborted && client.getState() === 'connected' && client.getGeneration?.() === generation
  const options = {
    signal,
    failWhenDisconnected: true,
    budgetSpansConnect: true,
    timeoutMs: 15_000
  }
  const { bot } = await runRpcOperation(client, commanderOpen, undefined, options)
  if (!current()) {
    throw new Error('commander_disconnected')
  }
  const { sessionId } = await runRpcOperation(client, homeChatOpen, { botId: bot.id }, options)
  if (!current()) {
    throw new Error('commander_disconnected')
  }
  return { bot, sessionId, current }
}

export async function openCommanderConversation(client: RpcClient, signal: AbortSignal) {
  const { bot, sessionId, current } = await openCommanderHome(client, signal)
  const opened = await openMobileStructuredSession({
    client,
    signal,
    current,
    source: {
      kind: 'history',
      structuredSession: { sessionId, workspaceId: botHomeWorktreeId(bot) }
    }
  })
  if (!current()) {
    throw new Error('commander_disconnected')
  }
  if (opened.kind !== 'opened') {
    throw new Error('commander_chat_unavailable')
  }
  return {
    worktreeId: opened.target.worktreeId,
    paneKey: structuredAgentSessionPaneKey(opened.tab.id, sessionId),
    sessionId,
    name: bot.name
  }
}
