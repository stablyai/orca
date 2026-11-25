// The open bot chat's Slack thread on the phone: read with the bot home's links, re-read when the
// host says its threads changed (a post's state is one), and acted on through the host.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../../transport/connection/connection-state'
import { startHostBotRefresh } from '../../../bots/host-bot-refresh'
import { readHostMethodReply } from '../../../host-screen/sidebar-feed/host-sidebar-feed-operations'
import type { SlackMirrorStatus } from '../../../../../src/shared/connectors/connector-slack-mirror-contract'
import { slackMirrorAvailable } from '../../../../../src/shared/connectors/slack-mirror-state'
import {
  slackMirrorLinksRead,
  slackMirrorPost,
  slackMirrorSet,
  slackMirrorStatusRead,
  type MobileSlackMirrorLink
} from './mobile-slack-mirror-operations'

export type MobileSlackMirror = {
  botName: string
  link: MobileSlackMirrorLink
  setOn: (on: boolean) => Promise<void>
  post: (itemId: string, action: 'retry' | 'dismiss' | 'delete') => Promise<void>
  status: () => Promise<SlackMirrorStatus | null>
  /** Opens the chat's Slack sheet, which the session screen draws. */
  openSheet: () => void
}

export const MobileSlackMirrorContext = createContext<MobileSlackMirror | null>(null)

export function useMobileSlackMirrorContext(): MobileSlackMirror | null {
  return useContext(MobileSlackMirrorContext)
}

export function useMobileSlackMirror(
  bot: { id: string; name: string; folderWorkspaceId: string } | null,
  client: RpcClient | null,
  connState: ConnectionState,
  sessionId: string | null,
  openSheet: () => void
): MobileSlackMirror | null {
  const [link, setLink] = useState<MobileSlackMirrorLink | null>(null)
  const readRef = useRef<() => void>(() => {})
  const folderId = bot?.folderWorkspaceId ?? null
  const botId = bot?.id ?? null
  useEffect(() => {
    if (!client || !folderId || !botId || !sessionId || connState !== 'connected') {
      setLink(null)
      return
    }
    let current = true
    let listed = false
    const read = (): void => {
      void slackMirrorLinksRead
        .request(client)
        .then((reply) => {
          const answer = readHostMethodReply(reply, slackMirrorLinksRead.interpret)
          if (!current || answer.kind !== 'answered') {
            return
          }
          listed = true
          const found = (answer.value[folderId] ?? []).find(
            (entry) =>
              entry.sessionId === sessionId &&
              entry.bot.botId === botId &&
              slackMirrorAvailable(entry)
          )
          setLink(found ?? null)
        })
        .catch(() => {})
    }
    readRef.current = read
    read()
    const stop = startHostBotRefresh({
      client,
      appState: AppState,
      refresh: read,
      listed: () => listed,
      interest: () => ({ kinds: ['threads'] })
    })
    return () => {
      current = false
      readRef.current = () => {}
      stop()
    }
  }, [client, folderId, botId, sessionId, connState])
  const botName = bot?.name ?? ''
  return useMemo(() => {
    if (!client || !link || !sessionId) {
      return null
    }
    const after = (sent: Promise<unknown>) =>
      sent.then(
        () => readRef.current(),
        () => readRef.current()
      )
    return {
      botName,
      link,
      openSheet,
      setOn: (on) => after(slackMirrorSet.request(client, { sessionId, on })),
      post: (itemId, action) =>
        after(slackMirrorPost.request(client, { sessionId, itemId, action })),
      status: async () => {
        try {
          const reply = await slackMirrorStatusRead.request(client, { sessionId })
          return slackMirrorStatusRead.interpret(reply).status
        } catch {
          return null
        }
      }
    }
  }, [client, link, sessionId, botName, openSheet])
}
