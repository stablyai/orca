import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  View,
  Text,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  ScrollView,
  TextInput,
  type TextInputProps
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { Check } from '../../../src/components/icons/app-icons'
import { colors, radii, spacing, typography, pressedStyle } from '../../../src/theme/mobile-theme'
import { NATIVE_SCREEN_HEADER, ScreenHeader } from '../../../src/components/nav-bar/ScreenHeader'
import { themedStyleSheet } from '../../../src/theme/themed-styles'
import { useMobileColorScheme } from '../../../src/theme/use-mobile-color-scheme'
import { loadHosts, updateHostNameAndEndpoint } from '../../../src/host-catalog/host-store'
import { displayHostEndpoint } from '../../../src/transport/hosts/host-endpoint'
import { resolveHostEndpointEdit } from '../../../src/transport/hosts/host-endpoint-edit'
import {
  useForgetHostClient,
  usePrimeHosts,
  useRefreshHostClient
} from '../../../src/transport/connection/host-client-hooks'
import { removeHostAndCloseClient } from '../../../src/host-catalog/host-removal-lifecycle'
import { useHostDisplay } from '../../../src/host-descriptors/use-host-display'
import { leaveHostRoute } from '../../../src/host-route-exit'
import { ConfirmModal } from '../../../src/components/sheets/ConfirmModal'
import {
  GroupedListScreen,
  LIST_ROW_PADDING,
  ListRow
} from '../../../src/components/list/ListGroup'
import type { HostProfile } from '../../../src/host-catalog/host-profile'
import { hostOs } from '../../../src/platform/host-os'
import { translate } from '../../../src/i18n/mobile-i18n'
import { useMobileTranslation } from '../../../src/i18n/use-mobile-translation'
import {
  SettingsNote,
  SettingsSection,
  settingsScreenStyles
} from '../../../src/settings/settings-screen-frame'
import { HostOrcaVersionSection } from '../../../src/host-screen/identity/HostOrcaVersionSection'

export default function EditHostScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const primeHosts = usePrimeHosts()
  const refreshHostClient = useRefreshHostClient()
  const forgetHostClient = useForgetHostClient()
  const queryClient = useQueryClient()

  const [host, setHost] = useState<HostProfile | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const hostTitle = useHostDisplay(host).title
  // Ref blocks re-entry before async setSaving rerenders.
  const savingRef = useRef(false)
  const routeRevision = useRef(0)
  const leave = () => {
    routeRevision.current += 1
    router.back()
  }
  // The native header's Back pops without leave(), so a save finishing mid-pop must not pop again.
  useFocusEffect(useCallback(() => () => void (routeRevision.current += 1), []))

  const load = useCallback(
    async (revision: number) => {
      if (!hostId) {
        setLoadError(translate('host.edit.missingHost', 'Missing host.'))
        return
      }
      try {
        const hosts = await loadHosts()
        if (revision !== routeRevision.current) {
          return
        }
        const found = hosts.find((h) => h.id === hostId) ?? null
        if (!found) {
          setLoadError(translate('host.edit.hostRemoved', 'This host was removed from this phone.'))
          setHost(null)
          return
        }
        setHost(found)
        // The field edits the phone's override; an empty field means "use the desktop's name".
        setName(found.personalName ?? '')
        setAddress(displayHostEndpoint(found.endpoint))
        setLoadError(null)
      } catch (err) {
        if (revision !== routeRevision.current) {
          return
        }
        setLoadError(
          err instanceof Error
            ? err.message
            : translate('host.edit.loadFailed', 'Failed to load host.')
        )
        setHost(null)
      }
    },
    [hostId]
  )

  useEffect(() => {
    const revision = ++routeRevision.current
    setHost(null)
    setLoadError(null)
    savingRef.current = false
    setSaving(false)
    void load(revision)
    return () => {
      routeRevision.current += 1
    }
  }, [load])

  const endpointEdit = useMemo(
    () => (host ? resolveHostEndpointEdit(host.endpoint, address) : null),
    [address, host, t]
  )

  const nameTrimmed = name.trim()
  const nameChanged = host != null && nameTrimmed !== (host.personalName ?? '')
  const endpointChanged = endpointEdit?.kind === 'changed'
  const canSave =
    host != null &&
    endpointEdit != null &&
    endpointEdit.kind !== 'invalid' &&
    (nameChanged || endpointChanged) &&
    !saving

  const fieldsNote = saveError ? (
    <SettingsNote error>{saveError}</SettingsNote>
  ) : endpointEdit?.kind === 'invalid' && address.trim().length > 0 ? (
    <SettingsNote error>{endpointEdit.error}</SettingsNote>
  ) : endpointEdit?.kind === 'changed' &&
    // Only when it adds something to what was typed, e.g. the kept port or the scheme.
    endpointEdit.endpoint.toLowerCase() !== address.trim().toLowerCase() ? (
    <SettingsNote>
      {t('host.edit.connectionPreview', 'Connects to {{endpoint}}', {
        endpoint: endpointEdit.endpoint
      })}
    </SettingsNote>
  ) : undefined

  async function handleSave() {
    if (!host || !hostId || !endpointEdit || savingRef.current) {
      return
    }
    const nextName = name.trim()
    if (endpointEdit.kind === 'invalid') {
      setSaveError(endpointEdit.error)
      return
    }

    const willRename = nextName !== (host.personalName ?? '')
    const nextEndpoint = endpointEdit.kind === 'changed' ? endpointEdit.endpoint : undefined
    if (!willRename && nextEndpoint === undefined) {
      router.back()
      return
    }

    const revision = routeRevision.current
    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    try {
      // Persist name+endpoint atomically; a removed host must throw rather than silently no-op.
      await updateHostNameAndEndpoint(host.id, {
        ...(willRename ? { personalName: nextName || null } : {}),
        ...(nextEndpoint !== undefined ? { endpoint: nextEndpoint } : {})
      })
    } catch (err) {
      // Always unblock Save: a screen pushed over this one mid-save comes back to it.
      savingRef.current = false
      setSaving(false)
      if (revision === routeRevision.current) {
        setSaveError(
          err instanceof Error ? err.message : t('host.edit.saveFailed', 'Failed to save host.')
        )
      }
      return
    }

    try {
      // Persistence already succeeded; failed re-prime must not report save failure. Later loadHosts picks up the committed data.
      const hosts = await loadHosts()
      primeHosts(hosts)
    } catch {
      // best-effort re-prime; persisted data is unaffected
    }

    savingRef.current = false
    setSaving(false)
    if (revision === routeRevision.current) {
      leave()
    }

    if (nextEndpoint !== undefined) {
      // Why: the live client, even one riding the relay, and its primed profile hold the old address.
      refreshHostClient(host.id)
    }
  }

  async function handleRemove() {
    if (!host) {
      return
    }
    try {
      await removeHostAndCloseClient(host.id, forgetHostClient, queryClient)
    } catch {
      setConfirmRemove(true)
      Alert.alert(
        t('home.screen.removeHostFailed', 'Could not remove host'),
        t('home.screen.tryAgain', 'Please try again.')
      )
      return
    }
    routeRevision.current += 1
    leaveHostRoute(router)
  }

  return (
    <View
      style={[
        settingsScreenStyles.groupedContainer,
        { paddingTop: NATIVE_SCREEN_HEADER ? 0 : insets.top }
      ]}
    >
      <ScreenHeader
        title={t('host.edit.title', 'Edit host')}
        onBack={leave}
        actions={[
          {
            id: 'save',
            icon: Check,
            label: t('host.edit.saveHost', 'Save host'),
            onPress: () => void handleSave(),
            disabled: !canSave
          }
        ]}
      />

      {loadError ? (
        <View style={styles.errorState}>
          <Text style={styles.errorText}>{loadError}</Text>
          <Pressable
            style={({ pressed }) => [styles.secondaryButton, pressed && pressedStyle]}
            onPress={leave}
          >
            <Text style={styles.secondaryButtonText}>{t('host.edit.goBack', 'Go back')}</Text>
          </Pressable>
        </View>
      ) : !host ? (
        <View style={styles.loadingState}>
          <ActivityIndicator color={colors.textSecondary} />
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={hostOs() === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={[
              settingsScreenStyles.scrollContent,
              { paddingBottom: insets.bottom + spacing.xl }
            ]}
            keyboardShouldPersistTaps="handled"
          >
            <GroupedListScreen>
              <SettingsSection first footer={fieldsNote}>
                <HostFieldRow
                  key="name"
                  label={t('host.edit.name', 'Name')}
                  value={name}
                  onChangeText={(value) => {
                    setName(value)
                    setSaveError(null)
                  }}
                  // An empty name falls back to the one the host reports, which the placeholder shows.
                  placeholder={
                    host.lastKnownMachineName ?? t('host.edit.hostNamePlaceholder', 'Host name')
                  }
                  autoCapitalize="words"
                  autoCorrect={false}
                  returnKeyType="next"
                />
                <HostFieldRow
                  key="address"
                  label={t('host.edit.address', 'Address')}
                  value={address}
                  onChangeText={(value) => {
                    setAddress(value)
                    setSaveError(null)
                  }}
                  placeholder="192.168.1.10:6768"
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
              </SettingsSection>

              <HostOrcaVersionSection />

              <SettingsSection>
                <ListRow
                  key="remove"
                  title={t('host.edit.removeHost', 'Remove host')}
                  destructive
                  disabled={saving}
                  onPress={() => setConfirmRemove(true)}
                />
              </SettingsSection>
            </GroupedListScreen>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
      <ConfirmModal
        visible={confirmRemove}
        title={t('home.screen.removeHostTitle', 'Remove Host')}
        message={t('home.screen.removeHostMessage', 'Remove "{{name}}"? You can re-pair later.', {
          name: hostTitle
        })}
        confirmLabel={t('common.remove', 'Remove')}
        destructive
        onConfirm={() => void handleRemove()}
        onCancel={() => setConfirmRemove(false)}
      />
    </View>
  )
}

type HostFieldRowProps = Omit<
  TextInputProps,
  'style' | 'placeholderTextColor' | 'selectionColor' | 'accessibilityLabel'
> & { label: string }

// An editable grouped-list row: the label where a ListRow's title sits, the text after it.
function HostFieldRow({ label, ...inputProps }: HostFieldRowProps) {
  useMobileColorScheme()
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel} numberOfLines={1}>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.accentBlue}
        style={styles.fieldInput}
        {...inputProps}
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  flex: {
    flex: 1
  },
  fieldRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: LIST_ROW_PADDING
  },
  fieldLabel: {
    minWidth: 72,
    fontSize: 15,
    color: colors.textPrimary
  },
  fieldInput: {
    flex: 1,
    minHeight: 48,
    paddingVertical: 0,
    fontSize: 15,
    color: colors.textPrimary,
    outlineWidth: 0
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
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  secondaryButtonText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  }
}))
