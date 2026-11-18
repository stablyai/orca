import { useEffect, useMemo, useState } from 'react'
import { botOwnsChatSession } from '../../../../src/shared/bots/bot-chat-identity'
import { mobileBotAvatarSource } from '../../bots/host-bot-row-facts'
import type { RouteBot } from '../../bots/use-route-bot'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../transport/connection/connection-state'
import { resumeFolderWorkspaceListRead } from '../../agent-history/mobile-agent-history-operations'
import type { MobileNativeChatBotIdentity } from './mobile-native-chat-bot-identity'

export function mobileBotOwnsLinkedSession(
  bot: { id: string; folderWorkspaceId: string },
  sessionId: string,
  metadata: unknown
): boolean {
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !('folderWorkspaces' in metadata) ||
    !Array.isArray(metadata.folderWorkspaces)
  ) {
    return false
  }
  const folders = metadata.folderWorkspaces.filter(
    (row: unknown) =>
      row !== null && typeof row === 'object' && 'id' in row && row.id === bot.folderWorkspaceId
  )
  const folder: unknown = folders.length === 1 ? folders[0] : null
  if (
    !folder ||
    typeof folder !== 'object' ||
    !('externalConversations' in folder) ||
    !Array.isArray(folder.externalConversations)
  ) {
    return false
  }
  return botOwnsChatSession(bot, sessionId, folder.externalConversations)
}

/** Reuse the route's execution-host client; legacy replies never establish thread ownership. */
export function useMobileBotChatIdentity(
  routeBot: RouteBot | null,
  client: RpcClient | null,
  connState: ConnectionState,
  sessionId: string | null
): MobileNativeChatBotIdentity | null {
  const bot = routeBot?.bot
  const botId = bot?.id
  const folderWorkspaceId = bot?.folderWorkspaceId
  const home = bot !== undefined && botOwnsChatSession(bot, sessionId)
  const [linked, setLinked] = useState<{
    client: RpcClient
    botId: string
    sessionId: string
    folderWorkspaceId: string
  } | null>(null)
  useEffect(() => {
    if (
      !botId ||
      !folderWorkspaceId ||
      !client ||
      !sessionId ||
      home ||
      connState !== 'connected'
    ) {
      return
    }
    let current = true
    void resumeFolderWorkspaceListRead
      .request(client)
      .then((reply) => {
        const result = resumeFolderWorkspaceListRead.interpret(reply)
        if (current) {
          setLinked(
            result.accepted &&
              mobileBotOwnsLinkedSession({ id: botId, folderWorkspaceId }, sessionId, result.value)
              ? { client, botId, sessionId, folderWorkspaceId }
              : null
          )
        }
      })
      .catch(() => {
        if (current) {
          setLinked(null)
        }
      })
    return () => {
      current = false
    }
  }, [botId, folderWorkspaceId, client, connState, sessionId, home])
  const owns =
    home ||
    (linked?.client === client &&
      linked?.botId === botId &&
      linked?.folderWorkspaceId === folderWorkspaceId &&
      linked?.sessionId === sessionId)
  const uploadUri = routeBot?.avatar.kind === 'image' ? routeBot.avatar.uri : undefined
  const avatar = useMemo(
    () => (bot ? mobileBotAvatarSource(bot, uploadUri) : null),
    [bot, uploadUri]
  )
  return useMemo(
    () =>
      owns && bot && avatar
        ? { botId: bot.id, name: bot.name, avatar, cancelledWaits: bot.cancelledWaits }
        : null,
    [owns, bot, avatar]
  )
}
