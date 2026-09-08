import { useEffect, useRef, type ReactNode } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { useHostClient } from '../transport/client-context'
import { useHostStatusGates } from '../transport/host-status-gates'
import { colors } from '../theme/mobile-theme'
import { ProtocolBlockScreen } from './ProtocolBlockScreen'
import { HostProtocolGatesProvider, useHostProtocolGates } from './host-protocol-gates-context'

export { HostProtocolGatesProvider, useHostProtocolGates }

type Props = {
  hostId: string | undefined
  children: ReactNode
}

// Why: single choke point above every /h/[hostId] route so a blocked verdict replaces the
// whole host UI (sidebar + detail stack) while the host list and other hosts stay usable.
export function HostProtocolGate({ hostId, children }: Props) {
  const { client, state } = useHostClient(hostId)
  const gates = useHostStatusGates({ hostId, client, connState: state })
  const { compatVerdict, statusPending } = gates
  const resolvedHostIdRef = useRef<string | null>(null)
  const mountedHostIdRef = useRef<string | null>(null)
  const hostKey = hostId ?? null
  const resolvedNow = state === 'connected' && client !== null && !statusPending
  const blocked = compatVerdict.kind === 'blocked'
  const pending = statusPending && resolvedHostIdRef.current !== hostKey
  const holdBack = pending && mountedHostIdRef.current !== hostKey

  // Why: React can replay or discard a render, so the latches record committed
  // outcomes only — a discarded children render must not count as mounted.
  useEffect(() => {
    if (resolvedNow) {
      resolvedHostIdRef.current = hostKey
    }
    if (blocked) {
      // Why: the block screen unmounts the routes, so a later pending window
      // must not assume a live tree it can overlay.
      mountedHostIdRef.current = null
    } else if (!holdBack) {
      mountedHostIdRef.current = hostKey
    }
  })

  if (holdBack) {
    // Why: nothing is mounted yet for this host, so hold the routes back entirely
    // rather than letting them mount (and fire their connect RPCs) pre-verdict.
    return (
      <View style={styles.pending}>
        <ActivityIndicator
          color={colors.textSecondary}
          accessibilityLabel="Checking host compatibility"
        />
      </View>
    )
  }
  if (blocked) {
    return <ProtocolBlockScreen verdict={compatVerdict} />
  }
  // Why: the host sidebar needs the same status fields; sharing the result avoids a second status.get per route.
  return (
    <HostProtocolGatesProvider value={gates}>
      <View style={styles.host}>
        <View
          style={styles.host}
          importantForAccessibility={pending ? 'no-hide-descendants' : 'auto'}
        >
          {children}
        </View>
        {pending ? (
          <View style={styles.pendingOverlay} pointerEvents="auto" accessibilityViewIsModal>
            <ActivityIndicator
              color={colors.textSecondary}
              accessibilityLabel="Checking host compatibility"
            />
          </View>
        ) : null}
      </View>
    </HostProtocolGatesProvider>
  )
}

const styles = StyleSheet.create({
  pending: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgBase
  },
  // Stays mounted across the overlay toggling so the routes below keep their identity.
  host: {
    flex: 1
  },
  pendingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgBase,
    zIndex: 1000,
    elevation: 1000
  }
})
