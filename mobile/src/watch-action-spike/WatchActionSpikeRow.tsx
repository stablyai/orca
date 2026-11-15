import { useCallback, useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Watch } from 'lucide-react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  OrcaWatchActionSpike,
  type WatchActionSpikeNativeEvent
} from '../../modules/orca-watch-action-spike/src/index'
import { ListGroup, ListRow } from '../components/list/ListGroup'
import { troubleshootScreenStyles as styles } from '../diagnostics/troubleshoot-screen-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { loadHosts } from '../transport/hosts/host-store'
import type { HostProfile } from '../transport/hosts/host-profile'
import { armWatchActionSpike } from './watch-action-spike-notifications'
import {
  clearWatchActionSpikeResults,
  readWatchActionSpikeResults,
  type WatchActionSpikeResult
} from './watch-action-spike-results'

// 60s outlasts the keychain's short post-lock grace, so a pass there proves locked reads.
const ARM_DELAYS_SECONDS = [15, 60] as const
const RELAXED_KEYCHAIN_KEY = 'orca:watch-spike:keychain-relaxed'

function time(at: number): string {
  return new Date(at).toLocaleTimeString()
}

function SpikeButton({ label, onPress }: { label: string; onPress: () => void }) {
  useMobileColorScheme()
  return (
    <Pressable
      style={({ pressed }) => [styles.diagnosticButton, pressed && styles.diagnosticButtonPressed]}
      onPress={onPress}
    >
      <Watch size={16} color={colors.textPrimary} />
      <Text style={styles.diagnosticButtonLabel}>{label}</Text>
    </Pressable>
  )
}

// ORCA_WATCH_SPIKE builds only: arms a mirrored notification and shows what each Watch tap did.
export function WatchActionSpikeRow() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [hosts, setHosts] = useState<readonly HostProfile[]>([])
  const [hostIndex, setHostIndex] = useState(0)
  const [status, setStatus] = useState<string | null>(null)
  const [relaxed, setRelaxed] = useState(false)
  const [results, setResults] = useState<WatchActionSpikeResult[]>([])
  const [events, setEvents] = useState<WatchActionSpikeNativeEvent[]>([])

  const refresh = useCallback(async () => {
    setResults(await readWatchActionSpikeResults())
    setEvents((await OrcaWatchActionSpike?.readEvents().catch(() => [])) ?? [])
    setRelaxed((await AsyncStorage.getItem(RELAXED_KEYCHAIN_KEY).catch(() => null)) === '1')
  }, [])

  useEffect(() => {
    void loadHosts()
      .then(setHosts)
      .catch(() => setHosts([]))
    void refresh()
  }, [refresh])

  const host = hosts.length > 0 ? hosts[hostIndex % hosts.length] : null

  const arm = async (seconds: number) => {
    if (!host) {
      return
    }
    await armWatchActionSpike(host.id, seconds)
    setStatus(
      t(
        'watchActionSpike.armed',
        'Armed. Lock the phone now; the test arrives on your Watch in {{seconds}}s.',
        { seconds }
      )
    )
  }

  const toggleKeychain = async () => {
    if (!OrcaWatchActionSpike) {
      setStatus(t('watchActionSpike.nativeMissing', 'Native spike module missing from this build.'))
      return
    }
    const next = !relaxed
    const outcome = await OrcaWatchActionSpike.setPairingKeychainReadableWhileLocked(next)
    await AsyncStorage.setItem(RELAXED_KEYCHAIN_KEY, next ? '1' : '0')
    setRelaxed(next)
    setStatus(
      t('watchActionSpike.keychainMoved', 'Moved {{count}} keychain items (status {{status}}).', {
        count: outcome.updated,
        status: outcome.status
      })
    )
  }

  const clear = async () => {
    await clearWatchActionSpikeResults()
    await OrcaWatchActionSpike?.clearEvents()
    await refresh()
  }

  return (
    <View>
      <ListGroup style={styles.group}>
        <ListRow
          key="host"
          title={t('watchActionSpike.host', 'Watch test host')}
          value={
            host ? (host.personalName ?? host.name) : t('watchActionSpike.noHost', 'No paired host')
          }
          onPress={hosts.length > 1 ? () => setHostIndex((index) => index + 1) : undefined}
        />
        <ListRow
          key="keychain"
          title={t('watchActionSpike.keychain', 'Pairing readable while locked')}
          value={relaxed ? t('watchActionSpike.on', 'On') : t('watchActionSpike.off', 'Off')}
          onPress={() => void toggleKeychain()}
        />
      </ListGroup>
      {ARM_DELAYS_SECONDS.map((seconds) => (
        <SpikeButton
          key={seconds}
          label={t('watchActionSpike.arm', 'Arm Watch test ({{seconds}}s)', { seconds })}
          onPress={() => void arm(seconds)}
        />
      ))}
      <SpikeButton
        label={t('watchActionSpike.refresh', 'Refresh results')}
        onPress={() => void refresh()}
      />
      <SpikeButton
        label={t('watchActionSpike.clear', 'Clear results')}
        onPress={() => void clear()}
      />
      {status ? <Text style={styles.checkDetail}>{status}</Text> : null}
      {results.length > 0 ? (
        <ListGroup style={styles.group}>
          {results.map((result) => (
            <ListRow
              key={`result-${result.at}`}
              title={`${time(result.at)} ${result.action.replace('orca.watch-spike.', '')} → ${result.outcome}`}
              detail={
                <Text style={styles.checkDetail} selectable>
                  {[
                    `total ${result.totalMs}ms · app ${result.appState} · native→JS ${result.nativeToJsMs ?? '?'}ms`,
                    result.path ? `path ${result.path}` : null,
                    result.failedStep ? `failed at ${result.failedStep}` : null,
                    result.replyText !== undefined ? `reply “${result.replyText}”` : null,
                    ...result.steps.map(
                      (step) => `+${step.ms}ms ${step.step}${step.detail ? ` ${step.detail}` : ''}`
                    ),
                    ...result.log.slice(-8)
                  ]
                    .filter(Boolean)
                    .join('\n')}
                </Text>
              }
            />
          ))}
        </ListGroup>
      ) : null}
      {events.length > 0 ? (
        <ListGroup style={styles.group}>
          <ListRow
            key="native"
            title={t('watchActionSpike.nativeTimeline', 'Native timeline')}
            detail={
              <Text style={styles.checkDetail} selectable>
                {events
                  .slice(-16)
                  .map((event) =>
                    [
                      time(event.at),
                      event.kind,
                      event.appState,
                      event.protectedData === undefined ? null : `protected=${event.protectedData}`,
                      event.action?.replace('orca.watch-spike.', ''),
                      event.reason,
                      event.heldMs !== undefined ? `${Math.round(event.heldMs)}ms` : null,
                      event.remainingSec !== undefined
                        ? `bg ${Math.round(event.remainingSec)}s`
                        : null
                    ]
                      .filter(Boolean)
                      .join(' ')
                  )
                  .join('\n')}
              </Text>
            }
          />
        </ListGroup>
      ) : null}
    </View>
  )
}
