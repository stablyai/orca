import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  View,
  Text,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Check, ChevronLeft } from 'lucide-react-native'
import { colors, spacing, pressedStyle } from '../../../src/theme/mobile-theme'
import { NavBar } from '../../../src/components/nav-bar/NavBar'
import { NavBarButton } from '../../../src/components/nav-bar/NavBarButton'
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
import { ConfirmModal } from '../../../src/components/ConfirmModal'
import { ListGroup, ListRow } from '../../../src/components/list/ListGroup'
import type { HostProfile } from '../../../src/host-catalog/host-profile'
import { hostOs } from '../../../src/platform/host-os'
import { translate } from '../../../src/i18n/mobile-i18n'
import { useMobileTranslation } from '../../../src/i18n/use-mobile-translation'
import { TextField } from '../../../src/components/composer-input/TextField'
import {
  EdgeAuthHeadersSection,
  useEdgeAuthHeaders,
  type EdgeAuthScrollTarget
} from '../../../src/components/edge-auth-headers-section'
import { hostEditStyles as styles } from '../../../src/components/host-edit-styles'
import { checkEdgeAuthEndpoint } from '../../../src/transport/endpoint-auth-headers'

export default function EditHostScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const primeHosts = usePrimeHosts()
  const refreshHostClient = useRefreshHostClient()
  const edgeAuth = useEdgeAuthHeaders()
  const { authNormalized, authChanged, loadAuthForHost } = edgeAuth
  const authScrollTarget = useRef<EdgeAuthScrollTarget | null>(null)
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
        try {
          await loadAuthForHost(found.id, found.endpoint, () => revision === routeRevision.current)
        } catch {
          if (revision === routeRevision.current) {
            setSaveError(
              translate(
                'edgeAuth.loadFailed',
                'Could not load edge authentication. Unlock protected storage and reopen this form.'
              )
            )
          }
        }
        if (revision !== routeRevision.current) {
          return
        }
        setHost(found)
        // The field edits the phone's override; an empty field means "use the desktop's name".
        setName(found.personalName ?? '')
        setAddress(displayHostEndpoint(found.endpoint))
        setLoadError(null)
      } catch {
        if (revision !== routeRevision.current) {
          return
        }
        setLoadError(translate('host.edit.loadFailed', 'Failed to load host.'))
        setHost(null)
      }
    },
    [hostId, loadAuthForHost]
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
  const authEndpointCheck = checkEdgeAuthEndpoint(
    authNormalized.ok && authChanged ? authNormalized.headers : null,
    endpointEdit?.kind !== 'invalid' ? endpointEdit?.endpoint : undefined
  )
  const canSave =
    host != null &&
    endpointEdit != null &&
    endpointEdit.kind !== 'invalid' &&
    authNormalized.ok &&
    !authEndpointCheck.blocked &&
    (nameChanged || endpointChanged || authChanged) &&
    !saving

  async function handleSave() {
    if (!host || !hostId || !endpointEdit || savingRef.current) {
      return
    }
    const nextName = name.trim()
    if (endpointEdit.kind === 'invalid') {
      setSaveError(endpointEdit.error)
      return
    }
    if (!authNormalized.ok || authEndpointCheck.blocked) {
      setSaveError(authNormalized.ok ? authEndpointCheck.error : authNormalized.error)
      return
    }

    const willRename = nextName !== (host.personalName ?? '')
    const nextEndpoint = endpointEdit.kind === 'changed' ? endpointEdit.endpoint : undefined
    if (!willRename && nextEndpoint === undefined && !authChanged) {
      leave()
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
          err instanceof Error ? err.message : t('host.edit.saveFailed', 'Failed to save host.')
        )
        savingRef.current = false
        setSaving(false)
      }
      return
    }

    if (revision !== routeRevision.current) {
      await reprimeHosts()
      if (nextEndpoint !== undefined) {
        refreshHostClient(host.id)
      }
      return
    }

    // Retrying after a keychain failure must compare against the committed address.
    setHost({ ...host, personalName: nextName || undefined, endpoint: endpointEdit.endpoint })

    if (authChanged) {
      try {
        await edgeAuth.persistAuthChanges(host.id, authNormalized.headers, endpointEdit.endpoint)
      } catch {
        if (revision === routeRevision.current) {
          setSaveError(t('edgeAuth.saveFailed', 'Could not save edge authentication.'))
          savingRef.current = false
          setSaving(false)
        }
        await reprimeHosts()
        if (nextEndpoint !== undefined) {
          refreshHostClient(host.id)
        }
        return
      }
    }

    await reprimeHosts()

    if (revision === routeRevision.current) {
      savingRef.current = false
      setSaving(false)
      leave()
    }

    if (nextEndpoint !== undefined || authChanged) {
      // Why: the live client, even one riding the relay, and its primed profile hold the old address.
      refreshHostClient(host.id)
    }
  }

  async function reprimeHosts() {
    try {
      primeHosts(await loadHosts())
    } catch {
      // The write already committed; another load can recover the cache.
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
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <NavBar
        leading={
          <NavBarButton
            icon={ChevronLeft}
            onPress={leave}
            accessibilityLabel={t('common.back', 'Back')}
          />
        }
        title={t('host.edit.title', 'Edit host')}
        trailing={
          <NavBarButton
            icon={Check}
            onPress={() => void handleSave()}
            disabled={!canSave}
            accessibilityLabel={t('host.edit.saveHost', 'Save host')}
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
            ref={(node) => {
              authScrollTarget.current = node
            }}
            contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + spacing.xl }]}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.help}>
              {t(
                'host.edit.help',
                'Change the display name or connection address. Leave the name empty to use the name the desktop reports. Address edits only switch where this phone connects — they do not re-pair. Use this when the same desktop is reachable at a different IP (for example home LAN vs Tailscale).'
              )}
            </Text>

            <Text style={styles.label}>{t('host.edit.name', 'Name')}</Text>
            <TextField
              accessibilityLabel={t('host.edit.name', 'Name')}
              value={name}
              onChangeText={(value) => {
                setName(value)
                setSaveError(null)
              }}
              placeholder={
                host.lastKnownMachineName ?? t('host.edit.hostNamePlaceholder', 'Host name')
              }
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="next"
            />

            <Text style={styles.label}>{t('host.edit.address', 'Address')}</Text>
            <TextField
              accessibilityLabel={t('host.edit.address', 'Address')}
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
            <Text style={styles.hint}>
              {t(
                'host.edit.addressHint',
                'Accepts IP, host:port, or ws:// / wss://. A wss:// URL without a port uses 443. Bare addresses keep the current port (or 6768).'
              )}
            </Text>

            {endpointEdit == null ? null : endpointEdit.kind !== 'invalid' ? (
              <Text style={styles.preview} numberOfLines={2}>
                {t('host.edit.connectionPreview', 'Connects to {{endpoint}}', {
                  endpoint: endpointEdit.endpoint
                })}
              </Text>
            ) : address.trim().length > 0 ? (
              <Text style={styles.previewError}>{endpointEdit.error}</Text>
            ) : null}

            {Platform.OS !== 'web' ? (
              <EdgeAuthHeadersSection
                rows={edgeAuth.authRows}
                storedCount={edgeAuth.storedAuthCount}
                error={authNormalized.ok ? authEndpointCheck.error : authNormalized.error}
                onRowsChange={(rows) => {
                  edgeAuth.setAuthRows(rows)
                  setSaveError(null)
                }}
                scrollViewRef={authScrollTarget}
              />
            ) : null}

            {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}

            <ListGroup style={styles.removeGroup}>
              <ListRow
                title={t('host.edit.removeHost', 'Remove host')}
                destructive
                disabled={saving}
                onPress={() => setConfirmRemove(true)}
              />
            </ListGroup>
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
