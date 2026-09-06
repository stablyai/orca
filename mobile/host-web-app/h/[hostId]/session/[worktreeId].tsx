import { useEffect, useMemo } from 'react'
import { SessionScreen } from '../../../../app/h/[hostId]/session/[worktreeId]'
import { useMobileWebNativeShell } from '../../../../../src/mobile-web/src/native-shell-channel'
import { webHostSessionTabOperations } from '../../../../src/session/web-host-session-tab-operations'
import { webHostSessionQuickCommandOperations } from '../../../../src/session/web-host-session-quick-command-operations'
import { webHostSessionTerminalOperations } from '../../../../src/session/web-host-session-terminal-operations'
import { webHostSessionTerminalFileOperations } from '../../../../src/session/web-host-session-terminal-file-operations'
import { webHostSessionFileOperations } from '../../../../src/session/web-host-session-file-operations'
import { webHostSessionMarkdownOperations } from '../../../../src/session/web-host-session-markdown-operations'
import { webHostSessionDeviceOperations } from '../../../../src/session/web-host-session-device-operations'
import { webHostSessionBrowserOperations } from '../../../../src/session/web-host-session-browser-operations'
import { webHostSessionDictationOperations } from '../../../../src/session/web-host-session-dictation-operations'
import { webHostSessionNativeChatOperations } from '../../../../src/session/web-host-session-native-chat-operations'
import { webHostSessionChatDraftOperations } from '../../../../src/session/web-host-session-chat-draft-operations'
import { webHostSessionChatPendingDeliveryOperations } from '../../../../src/session/web-host-session-chat-pending-delivery-operations'
import { useMobileWebRouteParams } from '../../../../src/mobile-web/use-mobile-web-route-params'

export default function HostMobileWebSessionRoute() {
  const shell = useMobileWebNativeShell()
  const { worktreeId, name } = useMobileWebRouteParams<{
    worktreeId: string
    name?: string
  }>()
  useEffect(() => {
    if (shell.context) {
      shell.rememberRoute({
        kind: 'session',
        workspaceId: worktreeId,
        workspaceName: name ?? ''
      })
    }
  }, [name, shell.context, shell.rememberRoute, worktreeId])
  const sessionTabOperations = useMemo(
    () => (shell.client ? webHostSessionTabOperations(shell.client) : undefined),
    [shell.client]
  )
  const sessionQuickCommandOperations = useMemo(
    () => (shell.client ? webHostSessionQuickCommandOperations(shell.client) : undefined),
    [shell.client]
  )
  const sessionTerminalOperations = useMemo(
    () => (shell.client ? webHostSessionTerminalOperations(shell.client) : undefined),
    [shell.client]
  )
  const sessionTerminalFileOperations = useMemo(
    () => (shell.client ? webHostSessionTerminalFileOperations(shell.client) : undefined),
    [shell.client]
  )
  const sessionFileOperations = useMemo(
    () => (shell.client ? webHostSessionFileOperations(shell.client) : undefined),
    [shell.client]
  )
  const sessionMarkdownOperations = useMemo(
    () => (shell.client ? webHostSessionMarkdownOperations(shell.client) : undefined),
    [shell.client]
  )
  const sessionDeviceOperations = useMemo(
    () => (shell.client ? webHostSessionDeviceOperations(shell.client) : undefined),
    [shell.client]
  )
  const sessionBrowserOperations = useMemo(
    () => (shell.client ? webHostSessionBrowserOperations(shell.client) : undefined),
    [shell.client]
  )
  const sessionDictationOperations = useMemo(
    () => (shell.client ? webHostSessionDictationOperations(shell.client) : undefined),
    [shell.client]
  )
  const sessionNativeChatOperations = useMemo(
    () => (shell.client ? webHostSessionNativeChatOperations(shell.client) : undefined),
    [shell.client]
  )
  const sessionChatDraftOperations = useMemo(
    () => (shell.client ? webHostSessionChatDraftOperations(shell.client) : undefined),
    [shell.client]
  )
  const sessionChatPendingDeliveryOperations = useMemo(
    () => (shell.client ? webHostSessionChatPendingDeliveryOperations(shell.client) : undefined),
    [shell.client]
  )
  const connectionState =
    shell.connection === 'offline'
      ? 'disconnected'
      : shell.connection === 'recovering'
        ? 'reconnecting'
        : shell.connection

  return (
    <SessionScreen
      sessionTabOperations={sessionTabOperations}
      sessionQuickCommandOperations={sessionQuickCommandOperations}
      sessionTerminalOperations={sessionTerminalOperations}
      sessionTerminalFileOperations={sessionTerminalFileOperations}
      sessionFileOperations={sessionFileOperations}
      sessionMarkdownOperations={sessionMarkdownOperations}
      sessionDeviceOperations={sessionDeviceOperations}
      sessionBrowserOperations={sessionBrowserOperations}
      sessionDictationOperations={sessionDictationOperations}
      sessionNativeChatOperations={sessionNativeChatOperations}
      sessionChatDraftOperations={sessionChatDraftOperations}
      sessionChatPendingDeliveryOperations={sessionChatPendingDeliveryOperations}
      connectionState={connectionState}
      nativeHostBinding={false}
      reconnect={() =>
        shell.client
          ? shell.client.navigationReconnect().then(() => undefined)
          : Promise.reject(new Error('Native shell channel unavailable'))
      }
      reconnectAttempts={shell.reconnectAttempts}
      lastConnectedAt={shell.lastConnectedAt}
    />
  )
}
