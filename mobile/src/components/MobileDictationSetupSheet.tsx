import { useCallback, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ChevronRight } from 'lucide-react-native'
import { BottomDrawer } from './BottomDrawer'
import { colors, spacing, typography } from '../theme/mobile-theme'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { useDictationSetupPoller } from '../dictation/use-dictation-setup-poller'
import {
  downloadDictationModel,
  fetchDictationSetup,
  isModelInFlight,
  setDictationConfig,
  type MobileSpeechSetup
} from '../dictation/mobile-dictation-setup'
import { fetchSpeechProviders } from '../dictation/mobile-speech-providers'
import { hasSpeechModelInFlight } from '../dictation/speech-provider-presentation'
import type { MobileSpeechProvidersState } from '../dictation/speech-provider-reply-schema'
import { SpeechModelGroupedList } from '../settings/speech-model-grouped-list'
import { useVoiceRequestFence } from '../settings/use-voice-request-fence'
import { useVoiceScopedErrors } from '../settings/use-voice-scoped-errors'
import { VoiceErrorList } from '../settings/voice-error-list'
import { MobileDictationLegacyModelRow } from './MobileDictationLegacyModelRow'

const POLL_INTERVAL_MS = 1500

type Props = {
  visible: boolean
  client: RpcClient | null
  // Why: provider/settings routes must configure this session's desktop, not the first connected one.
  hostId?: string
  onClose: () => void
  // Called after the user reaches a ready+enabled state, so the caller can retry.
  onReady?: () => void
}

// Lets the user enable dictation and download a speech model on the paired
// desktop, from the phone. Polls while a download is in flight.
export function MobileDictationSetupSheet({ visible, client, hostId, onClose, onReady }: Props) {
  const router = useRouter()
  const [setup, setSetup] = useState<MobileSpeechSetup | null>(null)
  // Why: desktops with the provider cabinet list every cloud model; older ones keep the legacy rows.
  const [cabinet, setCabinet] = useState<MobileSpeechProvidersState | null>(null)
  // Why: keyed by client so a re-pair probes the new desktop instead of trusting the old answer.
  const cabinetSupport = useRef(new WeakMap<object, boolean>())
  const [cabinetClient, setCabinetClient] = useState(client)
  const { errors, setScopeError, clearErrors } = useVoiceScopedErrors()
  const [shownVisible, setShownVisible] = useState(visible)
  const [busy, setBusy] = useState<string | null>(null)
  // Why: replies still in flight from the previous desktop must not repaint this one.
  const fence = useVoiceRequestFence(client)
  if (client !== cabinetClient) {
    setCabinetClient(client)
    setCabinet(null)
    setSetup(null)
    setBusy(null)
    clearErrors()
  }
  if (visible !== shownVisible) {
    setShownVisible(visible)
    // Why: reopening the sheet starts without the previous session's errors.
    if (visible) {
      clearErrors()
    }
  }
  const refresh = useCallback(async (): Promise<boolean | undefined> => {
    if (!client) {
      return false
    }
    const ticket = fence.peek()
    try {
      if (cabinetSupport.current.get(client) !== false) {
        const providers = await fetchSpeechProviders(client)
        cabinetSupport.current.set(client, providers !== null)
        if (!fence.isLatest(ticket)) {
          return undefined
        }
        if (providers) {
          setCabinet(providers)
          setScopeError('read', null)
          return hasSpeechModelInFlight(providers)
        }
      }
      const next = await fetchDictationSetup(client)
      if (!fence.isLatest(ticket)) {
        return undefined
      }
      setSetup(next)
      setScopeError('read', null)
      return next.models.some(isModelInFlight)
    } catch (err) {
      if (fence.isLatest(ticket)) {
        setScopeError('read', err instanceof Error ? err.message : 'Failed to load')
      }
      return undefined
    }
  }, [client, fence, setScopeError])

  const polling = cabinet
    ? hasSpeechModelInFlight(cabinet)
    : (setup?.models.some(isModelInFlight) ?? false)
  const refreshSetup = useDictationSetupPoller({
    visible: visible && client !== null,
    polling,
    refresh,
    intervalMs: POLL_INTERVAL_MS
  })

  const handleDownload = useCallback(
    async (model: { id: string }) => {
      if (!client) {
        return
      }
      const ticket = fence.begin('model')
      setBusy(model.id)
      setScopeError('model', null)
      try {
        await downloadDictationModel(client, model.id)
        await refreshSetup()
      } catch (err) {
        if (fence.isLatestInScope(ticket)) {
          triggerError()
          setScopeError('model', err instanceof Error ? err.message : 'Download failed')
        }
      } finally {
        if (fence.isSameHost(ticket)) {
          setBusy((prev) => (prev === model.id ? null : prev))
        }
      }
    },
    [client, fence, refreshSetup, setScopeError]
  )

  const handleUseModel = useCallback(
    async (model: { id: string }) => {
      if (!client) {
        return
      }
      const ticket = fence.begin('config')
      setBusy(model.id)
      setScopeError('config', null)
      try {
        const next = await setDictationConfig(client, { enabled: true, modelId: model.id })
        if (fence.claimSnapshot(ticket, refreshSetup)) {
          setSetup(next)
          setCabinet((prev) =>
            prev ? { ...prev, enabled: true, selectedModelId: model.id } : prev
          )
          setScopeError('read', null)
        }
        if (!fence.isLatestInScope(ticket)) {
          return
        }
        triggerSuccess()
        onReady?.()
      } catch (err) {
        if (fence.isLatestInScope(ticket)) {
          triggerError()
          setScopeError('config', err instanceof Error ? err.message : 'Could not select model')
        }
      } finally {
        if (fence.isSameHost(ticket)) {
          setBusy((prev) => (prev === model.id ? null : prev))
        }
      }
    },
    [client, fence, onReady, refreshSetup, setScopeError]
  )

  const handleToggleEnabled = useCallback(
    async (enabled: boolean) => {
      if (!client) {
        return
      }
      const ticket = fence.begin('config')
      setScopeError('config', null)
      try {
        const next = await setDictationConfig(client, { enabled })
        if (fence.claimSnapshot(ticket, refreshSetup)) {
          setSetup(next)
          setCabinet((prev) => (prev ? { ...prev, enabled } : prev))
          setScopeError('read', null)
        }
      } catch (err) {
        if (fence.isLatestInScope(ticket)) {
          setScopeError('config', err instanceof Error ? err.message : 'Could not update')
        }
      }
    },
    [client, fence, refreshSetup, setScopeError]
  )

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      {/* Why: BottomDrawer already scrolls its children in a keyboard-aware container;
          a nested capped ScrollView cut off the lower controls. */}
      <View>
        <Text style={styles.heading}>Set up voice dictation</Text>
        <Text style={styles.subtitle}>
          {cabinet
            ? 'Pick an on-device model or connect a cloud provider — all from here.'
            : 'Download a model and enable dictation on your desktop — all from here.'}
        </Text>

        {cabinet ? (
          <>
            <View style={styles.enableRow}>
              <Text style={styles.enableLabel}>Dictation enabled</Text>
              <Switch
                accessibilityLabel="Dictation enabled"
                value={cabinet.enabled === true}
                onValueChange={(v) => void handleToggleEnabled(v)}
              />
            </View>
            <SpeechModelGroupedList
              state={cabinet}
              busy={busy ? { modelId: busy, type: 'select' } : null}
              onSelect={(model) => void handleUseModel(model)}
              onDownload={(model) => void handleDownload(model)}
              onOpenProvider={(provider) => {
                onClose()
                router.push({
                  pathname: '/voice-provider',
                  params: hostId ? { providerId: provider.id, hostId } : { providerId: provider.id }
                })
              }}
            />
            <Pressable
              style={({ pressed }) => [styles.manageLink, pressed && styles.actionPressed]}
              accessibilityRole="button"
              onPress={() => {
                onClose()
                router.push({ pathname: '/voice-settings', params: hostId ? { hostId } : {} })
              }}
            >
              <Text style={styles.manageLinkText}>Manage providers and API keys</Text>
              <ChevronRight size={16} color={colors.textMuted} />
            </Pressable>
          </>
        ) : setup === null ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.textSecondary} />
          </View>
        ) : (
          <>
            <View style={styles.enableRow}>
              <Text style={styles.enableLabel}>Dictation enabled</Text>
              <Switch value={setup.enabled} onValueChange={(v) => void handleToggleEnabled(v)} />
            </View>

            {setup.models.map((model) => (
              <MobileDictationLegacyModelRow
                key={model.id}
                model={model}
                selected={model.id === setup.selectedModelId}
                busy={busy === model.id}
                onUse={() => void handleUseModel(model)}
                onDownload={() => void handleDownload(model)}
              />
            ))}
          </>
        )}
        <VoiceErrorList messages={errors} />
      </View>
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  heading: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    marginTop: spacing.xs,
    marginBottom: spacing.md
  },
  loading: { paddingVertical: spacing.xl, alignItems: 'center' },
  enableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    marginBottom: spacing.sm
  },
  enableLabel: { color: colors.textPrimary, fontSize: typography.bodySize },
  actionPressed: { opacity: 0.7 },
  manageLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: spacing.lg,
    minHeight: 44,
    paddingVertical: spacing.sm
  },
  // Why: flex 1 wraps a long (or large Dynamic Type) label instead of pushing the chevron out.
  manageLinkText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  }
})
