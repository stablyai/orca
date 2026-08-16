import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { useHostClient } from '../transport/client-context'
import { useHostStatusGates, type HostStatusGates } from '../transport/host-status-gates'
import { colors } from '../theme/mobile-theme'
import { ProtocolBlockScreen } from './ProtocolBlockScreen'

type Props = {
  hostId: string | undefined
  children: ReactNode
}

const HostStatusGatesContext = createContext<HostStatusGates | null>(null)

export function useHostProtocolGates(): HostStatusGates {
  const gates = useContext(HostStatusGatesContext)
  if (!gates) {
    throw new Error('useHostProtocolGates must be used inside <HostProtocolGate>')
  }
  return gates
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
    <HostStatusGatesContext.Provider value={gates}>
      <View style={styles.host}>
        <View
          style={styles.host}
          // Why: the overlay blocks in-tree touches but TalkBack can still walk the covered
          // stack; hide it while pending (Android counterpart of the overlay's iOS modal flag).
          importantForAccessibility={pending ? 'no-hide-descendants' : 'auto'}
        >
          {children}
        </View>
        {pending ? (
          // Why: once the stack is mounted, unmounting it for a pending status.get destroys
          // in-flight nested navigation, so cover it instead. Mount effects underneath still
          // run — they wait for connState 'connected' and every capability-dependent call
          // re-probes status.get itself, so nothing newer than the baseline fires here.
          <View
            style={styles.pendingOverlay}
            // Why: the fill owns the hit test for in-tree views only — native-Modal-hosted
            // surfaces (bottom drawers) present in a separate window above it and stay live.
            pointerEvents="auto"
            accessibilityViewIsModal
          >
            <ActivityIndicator
              color={colors.textSecondary}
              accessibilityLabel="Checking host compatibility"
            />
          </View>
        ) : null}
      </View>
    </HostStatusGatesContext.Provider>
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
