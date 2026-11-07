import { AuthFailedBanner } from '../components/AuthFailedBanner'
import { Presence } from '../components/AutoHeight'
import { HostDiagnosticsLink } from '../components/HostDiagnosticsLink'
import { HostRouteNoticeBanner } from '../components/HostRouteNoticeBanner'
import type { HostScreenController } from './use-host-screen-controller'

type NoticeController = Pick<
  HostScreenController,
  | 'connState'
  | 'hostId'
  | 'reconnectAttempts'
  | 'forceReconnectHost'
  | 'routeNotice'
  | 'noticeParam'
  | 'setDismissedNotice'
> & {
  relayRecovery: Pick<HostScreenController['relayRecovery'], 'pairingRejected'>
  router: Pick<HostScreenController['router'], 'push'>
  state: Pick<
    HostScreenController['state'],
    'serverNotice' | 'actionError' | 'setServerNotice' | 'setActionError' | 'setConfirmRemoveHost'
  >
}

export function HostScreenNotices({ controller }: { controller: NoticeController }) {
  const {
    connState,
    hostId,
    forceReconnectHost,
    relayRecovery,
    reconnectAttempts,
    router,
    routeNotice,
    noticeParam,
    setDismissedNotice,
    state
  } = controller
  return (
    <>
      <Presence>
        {(connState === 'auth-failed' || relayRecovery.pairingRejected) && (
          <AuthFailedBanner
            canRetry={!!hostId && forceReconnectHost !== null}
            onRetry={() => hostId && forceReconnectHost && void forceReconnectHost(hostId)}
            onRepair={() => router.push('/pair-scan')}
            onRemove={() => state.setConfirmRemoveHost(true)}
          />
        )}
      </Presence>
      {connState !== 'connected' &&
      !relayRecovery.pairingRejected &&
      reconnectAttempts >= 3 &&
      hostId ? (
        <HostDiagnosticsLink
          onPress={() =>
            router.push({
              pathname: '/connection-log',
              params: { hostId: String(hostId) }
            })
          }
        />
      ) : null}
      <Presence>
        {routeNotice && (
          <HostRouteNoticeBanner
            message={routeNotice}
            onDismiss={() => setDismissedNotice(noticeParam ?? null)}
          />
        )}
      </Presence>
      <Presence>
        {state.serverNotice ? (
          <HostRouteNoticeBanner
            message={state.serverNotice}
            onDismiss={() => state.setServerNotice(null)}
          />
        ) : null}
      </Presence>
      <Presence>
        {state.actionError !== '' && (
          <HostRouteNoticeBanner
            message={state.actionError}
            tone="failure"
            onDismiss={() => state.setActionError('')}
          />
        )}
      </Presence>
    </>
  )
}
