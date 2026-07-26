import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../../../src/theme/mobile-theme'
import { loadHosts, updateHostNameAndEndpoint } from '../../../src/transport/host-store'
import {
  displayHostEndpoint,
  endpointPort,
  endpointScheme,
  normalizeHostEndpoint
} from '../../../src/transport/host-endpoint'
import { useForceReconnect, usePrimeHosts } from '../../../src/transport/client-context'
import type { HostProfile } from '../../../src/transport/types'

export default function EditHostScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const primeHosts = usePrimeHosts()
  const forceReconnectHost = useForceReconnect()

  const [host, setHost] = useState<HostProfile | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Why: setSaving is async, so a second trigger before the re-render could
  // still read stale state and re-enter handleSave; the ref closes that race.
  const savingRef = useRef(false)

  const load = useCallback(async () => {
    if (!hostId) {
      setLoadError('Missing host.')
      return
    }
    try {
      const hosts = await loadHosts()
      const found = hosts.find((h) => h.id === hostId) ?? null
      if (!found) {
        setLoadError('This host was removed from this phone.')
        setHost(null)
        return
      }
      setHost(found)
      setName(found.name)
      setAddress(displayHostEndpoint(found.endpoint))
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load host.')
      setHost(null)
    }
  }, [hostId])

  useEffect(() => {
    void load()
  }, [load])

  const fallbackPort = host ? endpointPort(host.endpoint) : undefined
  const fallbackScheme = host ? endpointScheme(host.endpoint) : 'ws'

  const normalizedEndpoint = useMemo(
    () => normalizeHostEndpoint(address, { fallbackPort, fallbackScheme }),
    [address, fallbackPort, fallbackScheme]
  )

  const nameTrimmed = name.trim()
  const nameChanged = host != null && nameTrimmed.length > 0 && nameTrimmed !== host.name
  const endpointChanged =
    host != null && normalizedEndpoint.ok && normalizedEndpoint.endpoint !== host.endpoint
  const canSave =
    host != null &&
    nameTrimmed.length > 0 &&
    normalizedEndpoint.ok &&
    (nameChanged || endpointChanged) &&
    !saving

  async function handleSave() {
    if (!host || !hostId || savingRef.current) {
      return
    }
    const nextName = name.trim()
    if (!nextName) {
      setSaveError('Enter a name.')
      return
    }
    if (!normalizedEndpoint.ok) {
      setSaveError(normalizedEndpoint.error)
      return
    }

    const willRename = nextName !== host.name
    const willUpdateEndpoint = normalizedEndpoint.endpoint !== host.endpoint
    if (!willRename && !willUpdateEndpoint) {
      router.back()
      return
    }

    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    try {
      // Why: a single mutateStoredHosts pass so name + endpoint commit
      // atomically — a mid-save failure can never persist one without the
      // other, and a host removed mid-edit throws instead of no-oping.
      await updateHostNameAndEndpoint(host.id, {
        ...(willRename ? { name: nextName } : {}),
        ...(willUpdateEndpoint ? { endpoint: normalizedEndpoint.endpoint } : {})
      })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save host.')
      savingRef.current = false
      setSaving(false)
      return
    }

    try {
      // Why: the write already committed above; a re-prime failure here
      // must not be reported as a save failure — the next loadHosts() call
      // elsewhere in the app picks up the fresh state regardless.
      const hosts = await loadHosts()
      primeHosts(hosts)
    } catch {
      // best-effort re-prime; persisted data is unaffected
    }

    savingRef.current = false
    setSaving(false)
    router.back()

    if (willUpdateEndpoint) {
      // Why: reconnect is a follow-on side effect of a save that already
      // committed — its failure or a hang must not be reported as a save
      // failure or block navigating back.
      void forceReconnectHost(host.id).catch(() => {})
    }
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          style={styles.backButton}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Edit host</Text>
        <Pressable
          style={({ pressed }) => [
            styles.saveButton,
            (!canSave || pressed) && styles.saveButtonDisabled
          ]}
          onPress={() => void handleSave()}
          disabled={!canSave}
          accessibilityRole="button"
          accessibilityLabel="Save host"
        >
          {saving ? (
            <ActivityIndicator size="small" color={colors.bgBase} />
          ) : (
            <Text style={styles.saveButtonText}>Save</Text>
          )}
        </Pressable>
      </View>

      {loadError ? (
        <View style={styles.errorState}>
          <Text style={styles.errorText}>{loadError}</Text>
          <Pressable style={styles.secondaryButton} onPress={() => router.back()}>
            <Text style={styles.secondaryButtonText}>Go back</Text>
          </Pressable>
        </View>
      ) : !host ? (
        <View style={styles.loadingState}>
          <ActivityIndicator color={colors.textSecondary} />
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + spacing.xl }]}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.help}>
              Change the display name or connection address. Address edits only switch where this
              phone connects — they do not re-pair. Use this when the same desktop is reachable at a
              different IP (for example home LAN vs Tailscale).
            </Text>

            <Text style={styles.label}>Name</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel="Name"
              value={name}
              onChangeText={(value) => {
                setName(value)
                setSaveError(null)
              }}
              placeholder="Host name"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="next"
            />

            <Text style={styles.label}>Address</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel="Address"
              value={address}
              onChangeText={(value) => {
                setAddress(value)
                setSaveError(null)
              }}
              placeholder="192.168.1.10:6768"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              keyboardType="url"
              returnKeyType="done"
              onSubmitEditing={() => {
                if (canSave) {
                  void handleSave()
                }
              }}
            />
            <Text style={styles.hint}>
              Accepts IP, host:port, or ws:// / wss://. Missing port defaults to the current port
              (or 6768).
            </Text>

            {normalizedEndpoint.ok ? (
              <Text style={styles.preview} numberOfLines={2}>
                Connects to {normalizedEndpoint.endpoint}
              </Text>
            ) : address.trim().length > 0 ? (
              <Text style={styles.previewError}>{normalizedEndpoint.error}</Text>
            ) : null}

            {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  flex: {
    flex: 1
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm
  },
  backButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center'
  },
  heading: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: '700'
  },
  saveButton: {
    minWidth: 64,
    height: 34,
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.surfaceBright,
    alignItems: 'center',
    justifyContent: 'center'
  },
  saveButtonDisabled: {
    opacity: 0.4
  },
  saveButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  form: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm
  },
  help: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 20,
    marginBottom: spacing.sm
  },
  label: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '500',
    marginTop: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.4
  },
  input: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10
  },
  hint: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: 16
  },
  preview: {
    marginTop: spacing.sm,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : typography.monoFamily
  },
  previewError: {
    marginTop: spacing.sm,
    color: colors.statusRed,
    fontSize: typography.bodySize
  },
  errorText: {
    color: colors.statusRed,
    fontSize: typography.bodySize,
    marginTop: spacing.md
  },
  errorState: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    gap: spacing.md
  },
  loadingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  secondaryButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  secondaryButtonText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  }
})
