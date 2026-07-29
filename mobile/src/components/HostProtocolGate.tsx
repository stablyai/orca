import { createContext, useContext, useRef, type ReactNode } from 'react'
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
  const hostKey = hostId ?? null
  if (state === 'connected' && client && !statusPending) {
    resolvedHostIdRef.current = hostKey
  }
  if (statusPending && resolvedHostIdRef.current !== hostKey) {
    // Why: child routes may call newer RPCs on mount, so wait until compatibility is known.
    return (
      <View style={styles.pending}>
        <ActivityIndicator
          color={colors.textSecondary}
          accessibilityLabel="Checking host compatibility"
        />
      </View>
    )
  }
  if (compatVerdict.kind === 'blocked') {
    return <ProtocolBlockScreen verdict={compatVerdict} />
  }
  // Why: the host sidebar needs the same status fields; sharing the result avoids a second status.get per route.
  return <HostStatusGatesContext.Provider value={gates}>{children}</HostStatusGatesContext.Provider>
}

const styles = StyleSheet.create({
  pending: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgBase
  }
})
