import { useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useFocusEffect } from 'expo-router'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../src/shared/execution-host/execution-host'
import { structuredAgentSessionPaneKey } from '../../../../../../src/shared/agent-session/view/structured-agent-session-projection'
import { botHomeWorktreeId, hostBotsKey } from '../../../../bots/host-bots-read'
import { publishBotLink } from '../../../../bots/pending-bot-link'
import { openMobileStructuredSession } from '../../agent-session/open-mobile-structured-session'
import { useOpenMobileSession } from '../../../use-open-mobile-session'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { WorkspaceServerContext } from '../../../../worktree/execution-hosts/workspace-server-context'
import { publishHostBot, useHostBotsEntry } from '../../../../bots/host-bot-store'
import { MobileNewBotSheet } from '../../../../bots/MobileNewBotSheet'
import {
  MobileBotCardHostContext,
  type MobileBotCardHost,
  type MobileBotCardOfferEdit
} from './mobile-bot-card-host'
import { botCardChatOpener } from './mobile-bot-card-chat-open'

/** Gives a chat's bot cards their host, and holds New bot for an offer card's Edit: the computer is
 *  the one its proposer runs on, and the bot it makes answers that card. */
export function MobileBotCardHostProvider({
  client,
  hostId: pairedHostId,
  executionHost,
  hostTitle,
  children
}: {
  /** The chat's execution-host client. */
  client: RpcClient | null
  hostId: string
  executionHost: ExecutionHostId | undefined
  /** The paired computer's name. */
  hostTitle: string | null | undefined
  children: ReactNode
}): React.JSX.Element {
  const server = useContext(WorkspaceServerContext)
  const [editing, setEditing] = useState<MobileBotCardOfferEdit | null>(null)
  const openMobileSession = useOpenMobileSession()
  const chatOpener = useMemo(
    () =>
      botCardChatOpener({
        ready: async (bot, chatId, current) =>
          client
            ? openMobileStructuredSession({
                client,
                current,
                source: {
                  kind: 'history',
                  structuredSession: { sessionId: chatId, workspaceId: botHomeWorktreeId(bot) }
                }
              })
            : { kind: 'superseded' },
        show: (bot, chatId, opened) =>
          openMobileSession({
            hostId: pairedHostId,
            ...(executionHost ? { executionHost } : {}),
            worktreeId: opened.worktreeId,
            paneKey: structuredAgentSessionPaneKey(opened.tabId, chatId),
            name: bot.name
          }),
        home: (bot) => publishBotLink({ kind: 'bot', botId: bot.id })
      }),
    [client, pairedHostId, executionHost, openMobileSession]
  )
  // Leaving this chat drops an open still waiting on the host.
  useFocusEffect(useCallback(() => chatOpener.cancel, [chatOpener]))
  const host: MobileBotCardHost = useMemo(
    () => ({
      openBotChat: chatOpener.open,
      client,
      hostKey: hostBotsKey(pairedHostId, executionHost),
      pairedHostId,
      ...(executionHost ? { executionHost } : {}),
      hostLabel: (server ? server.name : hostTitle) ?? '',
      editOffer: setEditing
    }),
    [client, pairedHostId, executionHost, server, hostTitle, chatOpener]
  )
  const bots = useHostBotsEntry(editing ? host.hostKey : null)?.bots
  const hostId = host.executionHost ?? LOCAL_EXECUTION_HOST_ID
  return (
    <MobileBotCardHostContext.Provider value={host}>
      {children}
      {editing ? (
        <MobileNewBotSheet
          visible
          computerId={hostId}
          computers={[
            {
              id: hostId,
              hostId,
              label: host.hostLabel,
              ...(editing.templatePackages ? { templatePackages: true } : {})
            }
          ]}
          botNamesOn={() => bots?.map((bot) => bot.name) ?? []}
          clientFor={() => host.client}
          pairedClientFor={() => host.client}
          offer={editing}
          onClose={() => setEditing(null)}
          onCreated={(bot) => {
            setEditing(null)
            publishHostBot(host.hostKey, bot)
          }}
        />
      ) : null}
    </MobileBotCardHostContext.Provider>
  )
}
