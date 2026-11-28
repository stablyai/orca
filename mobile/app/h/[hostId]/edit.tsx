import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  View,
  Text,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  ScrollView
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Check } from 'lucide-react-native'
import { radii, spacing, typography, pressedStyle } from '../../../src/theme/mobile-theme'
import { NavBarButton } from '../../../src/components/nav-bar/NavBarButton'
import { themedStyleSheet, useThemedStyles } from '../../../src/theme/themed-styles'
import { useMobileColors } from '../../../src/theme/use-mobile-color-scheme'
import { loadHosts, updateHostNameAndEndpoint } from '../../../src/host-catalog/host-store'
import { displayHostEndpoint } from '../../../src/transport/hosts/host-endpoint'
import { resolveHostEndpointEdit } from '../../../src/transport/hosts/host-endpoint-edit'
import {
  useForgetHostClient,
  useHostClient,
  usePrimeHosts,
  useRefreshHostClient
} from '../../../src/transport/connection/host-client-hooks'
import { removeHostAndCloseClient } from '../../../src/host-catalog/host-removal-lifecycle'
import { useHostDisplay } from '../../../src/host-descriptors/use-host-display'
import { leaveHostRoute } from '../../../src/host-route-exit'
import { ConfirmModal } from '../../../src/components/sheets/ConfirmModal'
import { ListRow } from '../../../src/components/list/ListGroup'
import { TextField } from '../../../src/components/composer-input/TextField'
import { groupFieldStylesSheet } from '../../../src/components/composer-input/composer-input-styles'
import type { HostProfile } from '../../../src/host-catalog/host-profile'
import { hostOs } from '../../../src/platform/host-os'
import { translate } from '../../../src/i18n/mobile-i18n'
import { useMobileTranslation } from '../../../src/i18n/use-mobile-translation'
import {
  SettingsNavBar,
  SettingsNote,
  SettingsSection,
  settingsScreenStylesSheet
} from '../../../src/settings/settings-screen-frame'
import { HostUpdatesSection } from '../../../src/host-screen/identity/updates/HostUpdatesSection'
import { TransientToast, useTransientToast } from '../../../src/components/feedback/TransientToast'

export default function EditHostScreen() {
  const styles = useThemedStyles(stylesSheet)
  const groupFieldStyles = useThemedStyles(groupFieldStylesSheet)
  const settingsScreenStyles = useThemedStyles(settingsScreenStylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { hostId, update } = useLocalSearchParams<{ hostId: string; update?: string }>()
  const primeHosts = usePrimeHosts()
  const refreshHostClient = useRefreshHostClient()
  const forgetHostClient = useForgetHostClient()
  const hostConnection = useHostClient(hostId)
  const { message: toastMessage, showToast } = useTransientToast()
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

  const load = useCallback(
    async (revision: number) => {
      if (!hostId) {
        setLoadError(translate('host.edit.computerNotFound', 'This computer isn’t on this phone.'))
        return
      }
      try {
        const hosts = await loadHosts()
        if (revision !== routeRevision.current) {
          return
        }
        const found = hosts.find((h) => h.id === hostId) ?? null
        if (!found) {
          setLoadError(translate('host.edit.computerRemoved', 'This computer was removed.'))
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
            : translate('host.edit.couldNotLoad', 'Couldn’t load this computer.')
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
    () => (host ? resolveHostEndpointEdit(host.endpoint, address, t) : null),
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
      if (revision === routeRevision.current) {
        setSaveError(
          err instanceof Error
            ? err.message
            : t('host.edit.couldNotSave', 'Couldn’t save this computer.')
        )
        savingRef.current = false
        setSaving(false)
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

    if (revision === routeRevision.current) {
      savingRef.current = false
      setSaving(false)
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
        t('home.screen.removeComputerFailed', 'Couldn’t remove computer'),
        t('home.screen.tryAgain', 'Please try again.')
      )
      return
    }
    routeRevision.current += 1
    leaveHostRoute(router)
  }

  return (
    <View style={[settingsScreenStyles.container, { paddingTop: insets.top }]}>
      <SettingsNavBar
        onBack={leave}
        title={t('host.edit.editComputer', 'Edit computer')}
        trailing={
          <NavBarButton
            icon={Check}
            onPress={() => void handleSave()}
            disabled={!canSave}
            accessibilityLabel={t('host.edit.save', 'Save')}
          />
        }
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
            contentContainerStyle={[
              settingsScreenStyles.scrollContent,
              { paddingBottom: insets.bottom + spacing.xl }
            ]}
            keyboardShouldPersistTaps="handled"
          >
            <SettingsSection first footer={fieldsNote}>
              <TextField
                key="name"
                label={t('host.edit.name', 'Name')}
                value={name}
                onChangeText={(value) => {
                  setName(value)
                  setSaveError(null)
                }}
                // An empty name falls back to the one the host reports, which the placeholder shows.
                placeholder={host.lastKnownMachineName ?? t('host.edit.name', 'Name')}
                autoCapitalize="words"
                autoCorrect={false}
                returnKeyType="next"
                style={groupFieldStyles.line}
              />
              <TextField
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
                style={groupFieldStyles.line}
              />
            </SettingsSection>

            <HostUpdatesSection
              hostId={host.id}
              hostName={hostTitle}
              client={hostConnection.client}
              online={hostConnection.state === 'connected'}
              showToast={showToast}
              openUpdate={update === 'orca'}
            />

            <SettingsSection>
              <ListRow
                key="remove"
                title={t('host.edit.removeComputer', 'Remove computer')}
                destructive
                disabled={saving}
                onPress={() => setConfirmRemove(true)}
              />
            </SettingsSection>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
      <TransientToast message={toastMessage} bottomInset={insets.bottom} />
      <ConfirmModal
        visible={confirmRemove}
        title={t('home.screen.removeComputerTitle', 'Remove computer')}
        message={t(
          'home.screen.removeComputerMessage',
          'Remove “{{name}}”? You can pair it again later.',
          {
            name: hostTitle
          }
        )}
        confirmLabel={t('common.remove', 'Remove')}
        destructive
        onConfirm={() => void handleRemove()}
        onCancel={() => setConfirmRemove(false)}
      />
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  flex: {
    flex: 1
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
    backgroundColor: colors.sheetGroup
  },
  secondaryButtonText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  }
}))
