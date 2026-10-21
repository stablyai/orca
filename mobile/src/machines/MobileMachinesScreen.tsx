import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { Box, ChevronLeft, RefreshCw } from 'lucide-react-native'
import { ConfirmModal } from '../components/ConfirmModal'
import { useNow } from '../hooks/use-now'
import { useRouteHandoff } from '../navigation/route-handoff'
import { colors, spacing } from '../theme/mobile-theme'
import { useHostClient } from '../transport/host-client-hooks'
import { loadHosts } from '../transport/host-store'
import type { MobileMachine, MobileMachineProvider } from './machine-operations'
import { machineRowModel } from './machine-row-model'
import { styles } from './mobile-machines-screen-styles'
import { useHostMachines } from './use-host-machines'

function staleAge(fetchedAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - fetchedAt) / 60_000))
  return minutes < 1 ? 'just now' : `${minutes} min ago`
}

/**
 * The paired desktop's machines: read-only, with Wake and Sleep. Create, archive and delete stay
 * on the desktop. Drawn by the page, so prompts are `ConfirmModal`s and Back is the handoff's.
 */
export function MobileMachinesScreen() {
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const { client, state: connState } = useHostClient(hostId)
  const [hostName, setHostName] = useState('')
  const [focused, setFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const now = useNow(60_000, focused)
  const machines = useHostMachines({ client, connState, focused })
  const [sleepTarget, setSleepTarget] = useState<{
    provider: MobileMachineProvider
    machine: MobileMachine
  } | null>(null)

  useEffect(() => {
    let stale = false
    void loadHosts().then((hosts) => {
      if (!stale) {
        setHostName(hosts.find((host) => host.id === hostId)?.name ?? '')
      }
    })
    return () => {
      stale = true
    }
  }, [hostId])

  const renderMachine = (
    provider: MobileMachineProvider,
    machine: MobileMachine,
    stale: boolean
  ) => {
    const model = machineRowModel(
      machine,
      provider.clockOffsetMs,
      now,
      provider.capabilities?.verbs
    )
    const action = model.action
    const busy = machines.busy?.machineId === machine.id ? machines.busy.verb : null
    const run = () =>
      action === 'sleep'
        ? setSleepTarget({ provider, machine })
        : action
          ? void machines.act(provider.providerKey, machine.id, action)
          : undefined
    return (
      <View key={machine.id} style={[styles.row, stale && styles.rowStale]}>
        <View style={styles.rowMain}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {machine.name}
          </Text>
          <View style={styles.stateRow}>
            <View style={[styles.stateDot, { backgroundColor: model.stateColor }]} />
            <Text style={styles.stateText}>{model.stateLabel}</Text>
          </View>
          {model.subtitle ? (
            <Text style={styles.rowSubtitle} numberOfLines={2}>
              {model.subtitle}
            </Text>
          ) : null}
        </View>
        <View style={styles.rowTrailing}>
          {busy ? (
            <ActivityIndicator
              size="small"
              color={colors.textSecondary}
              accessibilityLabel={`${busy === 'wake' ? 'Waking' : 'Putting to sleep'} ${machine.name}`}
            />
          ) : action ? (
            <Pressable
              style={styles.actionButton}
              onPress={run}
              disabled={machines.busy !== null || connState !== 'connected'}
              accessibilityRole="button"
              accessibilityLabel={`${action === 'wake' ? 'Wake' : 'Sleep'} ${machine.name}`}
              hitSlop={8}
            >
              <Text style={styles.actionButtonText}>{action === 'wake' ? 'Wake' : 'Sleep'}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    )
  }

  const renderBody = () => {
    const { state } = machines
    if (state.status === 'loading') {
      return (
        <View style={styles.placeholder}>
          <ActivityIndicator color={colors.textSecondary} />
          <Text style={styles.placeholderText}>
            {connState === 'connected'
              ? 'Loading machines…'
              : `Connecting to ${hostName || 'host'}…`}
          </Text>
        </View>
      )
    }
    if (state.status === 'unavailable') {
      return (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>Machines aren’t available on this computer.</Text>
        </View>
      )
    }
    if (state.status === 'failed') {
      return (
        <View style={styles.placeholder}>
          <Text style={styles.errorText}>{state.error}</Text>
        </View>
      )
    }
    const stale = state.error !== null
    return (
      <>
        {stale ? (
          <Text style={styles.providerFailure}>
            {`Couldn’t refresh; showing machines as of ${staleAge(state.fetchedAt, now)}. ${state.error}`}
          </Text>
        ) : null}
        {state.providers.map((provider) => (
          <View key={provider.providerKey} style={styles.section}>
            <View style={styles.sectionHeader}>
              <Box size={14} color={colors.textSecondary} />
              <Text style={styles.sectionHeading}>{provider.name}</Text>
            </View>
            {provider.lastFailure ? (
              <Text style={styles.providerFailure}>{provider.lastFailure.message}</Text>
            ) : null}
            <View style={styles.card}>
              {provider.machines.length === 0 ? (
                <View style={styles.row}>
                  <Text style={styles.rowSubtitle}>No machines</Text>
                </View>
              ) : (
                provider.machines.map((machine, index) => (
                  <View key={machine.id}>
                    {index > 0 ? <View style={styles.separator} /> : null}
                    {renderMachine(provider, machine, stale)}
                  </View>
                ))
              )}
            </View>
          </View>
        ))}
        <View style={styles.footerHint}>
          <Box size={14} color={colors.textMuted} />
          <Text style={styles.footerHintText}>
            Create, archive and delete machines from the desktop.
          </Text>
        </View>
      </>
    )
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.topRow}>
        <Pressable
          style={styles.backButton}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.titleWrap}>
          <Text style={styles.heading}>Machines</Text>
          {hostName ? (
            <Text style={styles.subheading} numberOfLines={1}>
              {hostName}
            </Text>
          ) : null}
        </View>
        <Pressable
          style={styles.iconButton}
          onPress={() => void machines.refresh()}
          disabled={machines.refreshing || connState !== 'connected'}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Refresh machines"
        >
          {machines.refreshing ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <RefreshCw size={18} color={colors.textSecondary} />
          )}
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + spacing.xl }]}
      >
        {renderBody()}
      </ScrollView>
      <ConfirmModal
        visible={sleepTarget !== null}
        title={`Sleep ${sleepTarget?.machine.name ?? ''}?`}
        message="Terminals and agents running on it stop until it wakes."
        confirmLabel="Sleep"
        onConfirm={() => {
          const target = sleepTarget
          setSleepTarget(null)
          if (target) {
            void machines.act(target.provider.providerKey, target.machine.id, 'sleep')
          }
        }}
        onCancel={() => setSleepTarget(null)}
      />
      <ConfirmModal
        visible={machines.notice !== null}
        title={machines.notice?.title ?? ''}
        message={machines.notice?.message}
        confirmLabel="OK"
        cancelLabel={null}
        onCancel={machines.dismissNotice}
      />
    </SafeAreaView>
  )
}
