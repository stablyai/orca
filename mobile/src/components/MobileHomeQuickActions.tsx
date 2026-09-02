import { useRef, useState } from 'react'
import { Plus, QrCode } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { HostProfile } from '../transport/types'
import { hostEndpointLabel } from '../transport/host-endpoint-label'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { PickerModal } from './PickerModal'

type Props = {
  connectedHosts: HostProfile[]
  onPairDesktop: () => void
  onCreateWorkspace: (hostId: string) => void
}

function hostPickerOptions(hosts: HostProfile[]) {
  const entries = hosts.map((host) => ({
    host,
    endpointLabel: hostEndpointLabel(host.endpoint)
  }))
  const endpointCounts = new Map<string, number>()
  for (const entry of entries) {
    const endpointKey = JSON.stringify([entry.host.name, entry.endpointLabel])
    endpointCounts.set(endpointKey, (endpointCounts.get(endpointKey) ?? 0) + 1)
  }
  return entries.map((entry) => {
    const endpointKey = JSON.stringify([entry.host.name, entry.endpointLabel])
    const endpointCollides = (endpointCounts.get(endpointKey) ?? 0) > 1
    const subtitle = endpointCollides
      ? `${entry.endpointLabel} · ${entry.host.id}`
      : entry.endpointLabel
    return { value: entry.host.id, label: entry.host.name, subtitle }
  })
}

export function MobileHomeQuickActions(props: Props) {
  const [hostPickerForHostSet, setHostPickerForHostSet] = useState<string | null>(null)
  const pendingHostIdRef = useRef<string | null>(null)
  const canCreateWorkspace = props.connectedHosts.length > 0
  const hostSetKey = JSON.stringify(props.connectedHosts.map((host) => host.id))
  const hostPickerVisible = hostPickerForHostSet === hostSetKey
  if (hostPickerForHostSet !== null && !hostPickerVisible) {
    setHostPickerForHostSet(null)
  }

  function handleCreateWorkspace() {
    if (props.connectedHosts.length === 1) {
      props.onCreateWorkspace(props.connectedHosts[0].id)
      return
    }
    if (props.connectedHosts.length > 1) {
      setHostPickerForHostSet(hostSetKey)
    }
  }

  function handleHostSelect(hostId: string) {
    pendingHostIdRef.current = hostId
    setHostPickerForHostSet(null)
  }

  function handleHostPickerClosed() {
    setHostPickerForHostSet(null)
    const hostId = pendingHostIdRef.current
    pendingHostIdRef.current = null
    if (hostId && props.connectedHosts.some((host) => host.id === hostId)) {
      props.onCreateWorkspace(hostId)
    }
  }

  return (
    <>
      <Text style={styles.sectionHeading}>Quick Actions</Text>
      <View style={styles.quickActions}>
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.quickAction, pressed && styles.quickActionPressed]}
          onPress={props.onPairDesktop}
        >
          <View style={styles.quickActionIcon}>
            <QrCode size={16} color={colors.textSecondary} />
          </View>
          <Text style={styles.quickActionLabel}>Pair Desktop</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canCreateWorkspace }}
          disabled={!canCreateWorkspace}
          style={({ pressed }) => [
            styles.quickAction,
            !canCreateWorkspace && styles.quickActionDisabled,
            pressed && styles.quickActionPressed
          ]}
          onPress={handleCreateWorkspace}
        >
          <View style={styles.quickActionIcon}>
            <Plus size={16} color={colors.textSecondary} />
          </View>
          <Text style={styles.quickActionLabel}>New Workspace</Text>
        </Pressable>
      </View>
      <PickerModal
        visible={hostPickerVisible}
        title="Create Workspace On"
        options={hostPickerOptions(props.connectedHosts)}
        selected=""
        onSelect={handleHostSelect}
        onClose={() => setHostPickerForHostSet(null)}
        onAfterClose={handleHostPickerClosed}
      />
    </>
  )
}

const styles = StyleSheet.create({
  sectionHeading: {
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6
  },
  quickActions: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  quickAction: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel
  },
  quickActionPressed: {
    backgroundColor: colors.bgRaised
  },
  quickActionDisabled: {
    opacity: 0.45
  },
  quickActionIcon: {
    width: 28,
    height: 28,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  quickActionLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600'
  }
})
