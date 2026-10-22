import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { colors, spacing } from '../../../src/theme/mobile-theme'
import { loadHosts, updateHostNameAndEndpoint } from '../../../src/transport/host-store'
import { displayHostEndpoint } from '../../../src/transport/host-endpoint'
import { resolveHostEndpointEdit } from '../../../src/transport/host-endpoint-edit'
import { usePrimeHosts, useRefreshHostClient } from '../../../src/transport/host-client-hooks'
import type { HostProfile } from '../../../src/transport/types'
import { hostOs } from '../../../src/platform/host-os'
import {
  EdgeAuthHeadersSection,
  useEdgeAuthHeaders,
  type EdgeAuthScrollTarget
} from '../../../src/components/edge-auth-headers-section'
import { hostEditStyles as styles } from '../../../src/components/host-edit-styles'
import { checkEdgeAuthEndpoint } from '../../../src/transport/endpoint-auth-headers'

export default function EditHostScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const primeHosts = usePrimeHosts()
  const refreshHostClient = useRefreshHostClient()
  const edgeAuth = useEdgeAuthHeaders()
  const { authNormalized, authChanged, loadAuthForHost } = edgeAuth
  const authScrollTarget = useRef<EdgeAuthScrollTarget | null>(null)

  const [host, setHost] = useState<HostProfile | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Why: setSaving is async, so a second trigger before the re-render could
  // still read stale state and re-enter handleSave; the ref closes that race.
  const savingRef = useRef(false)
  const routeRevision = useRef(0)
  const leave = () => {
    routeRevision.current += 1
    router.back()
  }

  const load = useCallback(
    async (revision: number) => {
      if (!hostId) {
        setLoadError('Missing host.')
        return
      }
      try {
        const hosts = await loadHosts()
        if (revision !== routeRevision.current) {
          return
        }
        const found = hosts.find((h) => h.id === hostId) ?? null
        if (!found) {
          setLoadError('This host was removed from this phone.')
          setHost(null)
          return
        }
        await loadAuthForHost(found.id, found.endpoint, () => revision === routeRevision.current)
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
        setLoadError('Failed to load host or edge authentication.')
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
    [address, host]
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
      // Why: a single mutateStoredHosts pass so name + endpoint commit
      // atomically — a mid-save failure can never persist one without the
      // other, and a host removed mid-edit throws instead of no-oping.
      await updateHostNameAndEndpoint(host.id, {
        ...(willRename ? { personalName: nextName || null } : {}),
        ...(nextEndpoint !== undefined ? { endpoint: nextEndpoint } : {})
      })
    } catch (err) {
      if (revision === routeRevision.current) {
        setSaveError(err instanceof Error ? err.message : 'Failed to save host.')
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
          setSaveError('Could not save edge authentication.')
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

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          style={styles.backButton}
          onPress={leave}
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
          <Pressable style={styles.secondaryButton} onPress={leave}>
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
              Change the display name or connection address. Leave the name empty to use the name
              the desktop reports. Address edits only switch where this phone connects — they do not
              re-pair. Use this when the same desktop is reachable at a different IP (for example
              home LAN vs Tailscale).
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
              placeholder={host.lastKnownMachineName ?? 'Host name'}
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
              Accepts IP, host:port, or ws:// / wss://. A wss:// URL without a port uses 443. Bare
              addresses keep the current port (or 6768).
            </Text>

            {endpointEdit == null ? null : endpointEdit.kind !== 'invalid' ? (
              <Text style={styles.preview} numberOfLines={2}>
                Connects to {endpointEdit.endpoint}
              </Text>
            ) : address.trim().length > 0 ? (
              <Text style={styles.previewError}>{endpointEdit.error}</Text>
            ) : null}

            {Platform.OS !== 'web' ? (
              <EdgeAuthHeadersSection
                rows={edgeAuth.authRows}
                storedCount={edgeAuth.storedAuthCount}
                error={authNormalized.ok ? authEndpointCheck.error : authNormalized.error}
                onRowsChange={edgeAuth.setAuthRows}
                scrollViewRef={authScrollTarget}
              />
            ) : null}

            {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </View>
  )
}
