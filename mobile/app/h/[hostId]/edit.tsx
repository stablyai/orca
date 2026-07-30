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
import { displayHostEndpoint } from '../../../src/transport/host-endpoint'
import { resolveHostEndpointEdit } from '../../../src/transport/host-endpoint-edit'
import { useForceReconnect, usePrimeHosts } from '../../../src/transport/client-context'
import type { HostProfile } from '../../../src/transport/types'
import { t } from '@/i18n/mobile-i18n'

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
      setLoadError(t('m.yLNjPPk'))
      return
    }
    try {
      const hosts = await loadHosts()
      const found = hosts.find((h) => h.id === hostId) ?? null
      if (!found) {
        setLoadError(t('m.T_ULLfI'))
        setHost(null)
        return
      }
      setHost(found)
      setName(found.name)
      setAddress(displayHostEndpoint(found.endpoint))
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('m.koyS6Oc'))
      setHost(null)
    }
  }, [hostId])

  useEffect(() => {
    void load()
  }, [load])

  const endpointEdit = useMemo(
    () => (host ? resolveHostEndpointEdit(host.endpoint, address) : null),
    [address, host]
  )

  const nameTrimmed = name.trim()
  const nameChanged = host != null && nameTrimmed.length > 0 && nameTrimmed !== host.name
  const endpointChanged = endpointEdit?.kind === 'changed'
  const canSave =
    host != null &&
    endpointEdit != null &&
    nameTrimmed.length > 0 &&
    endpointEdit.kind !== 'invalid' &&
    (nameChanged || endpointChanged) &&
    !saving

  async function handleSave() {
    if (!host || !hostId || !endpointEdit || savingRef.current) {
      return
    }
    const nextName = name.trim()
    if (!nextName) {
      setSaveError(t('m.7UECNUc'))
      return
    }
    if (endpointEdit.kind === 'invalid') {
      setSaveError(endpointEdit.error)
      return
    }

    const willRename = nextName !== host.name
    const nextEndpoint = endpointEdit.kind === 'changed' ? endpointEdit.endpoint : undefined
    if (!willRename && nextEndpoint === undefined) {
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
        ...(nextEndpoint !== undefined ? { endpoint: nextEndpoint } : {})
      })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('m.sI26LXo'))
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

    if (nextEndpoint !== undefined) {
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
          accessibilityLabel={t('m.K8w9o8U')}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>{t('m.NKISHlY')}</Text>
        <Pressable
          style={({ pressed }) => [
            styles.saveButton,
            (!canSave || pressed) && styles.saveButtonDisabled
          ]}
          onPress={() => void handleSave()}
          disabled={!canSave}
          accessibilityRole="button"
          accessibilityLabel={t('m.ugYhCr4')}
        >
          {saving ? (
            <ActivityIndicator size="small" color={colors.bgBase} />
          ) : (
            <Text style={styles.saveButtonText}>{t('m.OOhGw28')}</Text>
          )}
        </Pressable>
      </View>

      {loadError ? (
        <View style={styles.errorState}>
          <Text style={styles.errorText}>{loadError}</Text>
          <Pressable style={styles.secondaryButton} onPress={() => router.back()}>
            <Text style={styles.secondaryButtonText}>{t('m.LS3NecQ')}</Text>
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
            <Text style={styles.help}>{t('m.KytWtss')}</Text>

            <Text style={styles.label}>{t('m.wLjwLQg')}</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel={t('m.wLjwLQg')}
              value={name}
              onChangeText={(value) => {
                setName(value)
                setSaveError(null)
              }}
              placeholder={t('m.jHccG1s')}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="next"
            />

            <Text style={styles.label}>{t('m.kMmtf5E')}</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel={t('m.kMmtf5E')}
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
            <Text style={styles.hint}>{t('m.dYplni8')}</Text>

            {endpointEdit == null ? null : endpointEdit.kind !== 'invalid' ? (
              <Text style={styles.preview} numberOfLines={2}>
                {t('m.eB5hKE4', { value0: endpointEdit.endpoint })}
              </Text>
            ) : address.trim().length > 0 ? (
              <Text style={styles.previewError}>{endpointEdit.error}</Text>
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
