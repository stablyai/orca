import { useEffect, useRef, type ReactNode } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { useHostClient } from '../transport/host-client-hooks'
import { useHostStatusGates } from '../transport/host-status-gates'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { HostStatusGatesContext } from './host-protocol-gates-context'
import { ProtocolBlockScreen } from './ProtocolBlockScreen'

type Props = {
  hostId: string | undefined
  children: ReactNode
  /** For a route drawn over another screen: nothing shows while status is pending, not a spinner. */
  transparentWhilePending?: boolean
  /** In place of the block screen, for a route that hands a blocked host to the host list. */
  blocked?: ReactNode
}

// Gate all /h/[hostId] UI together while leaving host list/other hosts usable.
export function HostProtocolGate({
  hostId,
  children,
  transparentWhilePending = false,
  blocked: blockedView
}: Props) {
  useMobileColorScheme()
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
  const covered = pending && !transparentWhilePending

  // Latch committed outcomes only; discarded/replayed React renders cannot count as mounted.
  useEffect(() => {
    if (resolvedNow) {
      resolvedHostIdRef.current = hostKey
    }
    if (blocked) {
      // Block screen unmounts routes; later pending verdict cannot assume live tree to overlay.
      mountedHostIdRef.current = null
    } else if (!holdBack) {
      mountedHostIdRef.current = hostKey
    }
  })

  if (holdBack && transparentWhilePending) {
    return null
  }
  if (holdBack) {
    // Hold new host routes until verdict so mount effects cannot send RPCs prematurely.
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
    return blockedView ?? <ProtocolBlockScreen verdict={compatVerdict} />
  }
  // Why: the host sidebar needs the same status fields; sharing the result avoids a second status.get per route.
  return (
    <HostStatusGatesContext.Provider value={gates}>
      <View style={styles.host}>
        <View
          style={styles.host}
          // Hide pending stack from TalkBack too; touch overlay alone does not block Android screen-reader navigation.
          importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'}
        >
          {children}
        </View>
        {covered ? (
          // Cover mounted routes during pending status instead of destroying nested navigation.
          // Underlying mount effects still run, but await connected state and re-probe capabilities before newer-than-baseline calls.
          <View
            style={styles.pendingOverlay}
            // Overlay blocks in-tree touches only; native modal drawers live above it and remain interactive.
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

const styles = themedStyleSheet(() => ({
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
}))
