import {
  isConnectionOutage,
  type ConnectionVerdict
} from '../../transport/connection/connection-health'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { ServerHostDesktopReach } from '../../worktree/server-workspaces'
import { translate, type Translate } from '../../i18n/mobile-i18n'
import { formatOfflineAsOfTime } from '../../components/offline-as-of-time'
import type { MobileSessionController } from '../use-mobile-session-controller'

/** The composer's status line while the chat's host is out, with Reconnect only when redialing can help. */
export type MobileNativeChatHostOutage = { text: string; onReconnect?: () => void }

/** Name the link that is down: the paired desktop, or the server behind it that the phone cannot start or redial. */
export function mobileNativeChatHostOutage(
  args: {
    pairedHostState: ConnectionState
    /** The session's verdict, which reads the paired desktop link whenever that link is down. */
    pairedVerdict: ConnectionVerdict
    hostName: string
    /** The session header's Reconnect when it offers one, so the composer offers the same. */
    reconnect: (() => void) | null
    /** Before this page's first connect (a relaunch), the header covers connecting until an offline verdict. */
    neverConnected?: boolean
    /** When the chat on screen was saved, while it is a stored copy no read has confirmed. */
    savedAt?: number | null
    server?: {
      state: ConnectionState
      name?: string | null
      desktopReach?: ServerHostDesktopReach
    }
  },
  t: Translate = translate
): MobileNativeChatHostOutage | null {
  const linkText = (host: string, offline: boolean): string =>
    offline
      ? t('connection.connectionHealth.hostOffline', '{{host}} is offline', { host })
      : t('chat.hostOutage.reconnecting', '{{hostName}} is reconnecting…', { hostName: host })
  const { pairedVerdict: verdict, savedAt } = args
  if (args.pairedHostState !== 'connected') {
    if (verdict.kind === 'auth-failed') {
      return { text: verdict.label }
    }
    const offline = isConnectionOutage(verdict)
    if (!offline && args.neverConnected) {
      return null
    }
    const text =
      offline && savedAt != null
        ? t('chat.hostOutage.offlineAsOf', '{{host}} is offline · as of {{time}}', {
            host: args.hostName,
            time: formatOfflineAsOfTime(savedAt)
          })
        : linkText(args.hostName, offline)
    return offline && args.reconnect ? { text, onReconnect: args.reconnect } : { text }
  }
  const { server } = args
  if (!server || server.state === 'connected') {
    return null
  }
  const hostName = server.name || t('chat.hostOutage.server', 'The server')
  // Why no action: a phone never starts or redials the desktop's servers.
  switch (server.desktopReach) {
    case 'stopped':
      return {
        text: t('chat.hostOutage.stopped', '{{hostName}} is stopped. Start it on your computer.', {
          hostName
        })
      }
    case 'unavailable':
      return {
        text: t(
          'chat.hostOutage.unavailable',
          "{{hostName}} isn't available from your phone. Open one of its projects on your computer.",
          { hostName }
        )
      }
    case undefined:
      return { text: linkText(hostName, server.state === 'disconnected') }
  }
}

/** A session chat's outage line, shown only while its composer is locked for a lost link. */
export function mobileSessionNativeChatHostOutage(
  session: Pick<
    MobileSessionController,
    | 'hostId'
    | 'nativeChatOverlayInputLockReason'
    | 'pairedHostState'
    | 'connectionVerdict'
    | 'showConnectionRetry'
    | 'forceReconnectHost'
    | 'workspaceServer'
    | 'lastConnectedAt'
    | 'nativeChatController'
  >,
  hostName: string,
  t: Translate
): MobileNativeChatHostOutage | null {
  const { hostId, forceReconnectHost: forceReconnect } = session
  if (session.nativeChatOverlayInputLockReason !== 'disconnected') {
    return null
  }
  return mobileNativeChatHostOutage(
    {
      pairedHostState: session.pairedHostState,
      pairedVerdict: session.connectionVerdict,
      hostName,
      reconnect:
        session.showConnectionRetry && hostId && forceReconnect
          ? () => void forceReconnect(hostId)
          : null,
      neverConnected: session.lastConnectedAt === null,
      savedAt: session.nativeChatController.nativeChatSession.savedAt,
      server: session.workspaceServer
    },
    t
  )
}
