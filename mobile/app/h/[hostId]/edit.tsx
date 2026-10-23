import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { AlertCircle } from 'lucide-react-native'
import { colors, spacing, textStyles, typography } from '../../../src/theme/mobile-theme'
import { NavBar } from '../../../src/components/ui/NavBar'
import { Button } from '../../../src/components/ui/Button'
import { TextField } from '../../../src/components/ui/TextField'
import { StateView } from '../../../src/components/ui/StateView'
import { Banner } from '../../../src/components/ui/Banner'
import { SETTINGS_CONTENT_MAX_WIDTH } from '../../../src/settings/settings-screen-frame'
import { loadHosts, updateHostNameAndEndpoint } from '../../../src/transport/host-store'
import { displayHostEndpoint } from '../../../src/transport/host-endpoint'
import { resolveHostEndpointEdit } from '../../../src/transport/host-endpoint-edit'
import { usePrimeHosts, useRefreshHostClient } from '../../../src/transport/host-client-hooks'
import type { HostProfile } from '../../../src/transport/types'
import { hostOs } from '../../../src/platform/host-os'

export default function EditHostScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const primeHosts = usePrimeHosts()
  const refreshHostClient = useRefreshHostClient()

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
        setLoadError('This link does not name a desktop.')
        return
      }
      try {
        const hosts = await loadHosts()
        if (revision !== routeRevision.current) {
          return
        }
        const found = hosts.find((h) => h.id === hostId) ?? null
        if (!found) {
          setLoadError('This desktop was removed from this phone.')
          setHost(null)
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
        setLoadError('Its details could not be read from this phone.')
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
    [address, host]
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
      // Why: a single mutateStoredHosts pass so name + endpoint commit
      // atomically — a mid-save failure can never persist one without the
      // other, and a host removed mid-edit throws instead of no-oping.
      await updateHostNameAndEndpoint(host.id, {
        ...(willRename ? { personalName: nextName || null } : {}),
        ...(nextEndpoint !== undefined ? { endpoint: nextEndpoint } : {})
      })
    } catch (err) {
      if (revision === routeRevision.current) {
        setSaveError(err instanceof Error ? err.message : 'The changes could not be saved.')
        savingRef.current = false
        setSaving(false)
      }
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

  const addressInvalid =
    endpointEdit?.kind === 'invalid' && address.trim().length > 0 ? endpointEdit.error : null

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <NavBar
        title="Edit desktop"
        onBack={leave}
        trailing={
          host ? (
            <Button
              label="Save"
              variant="primary"
              size="compact"
              busy={saving}
              disabled={!canSave}
              accessibilityLabel="Save host"
              onPress={() => void handleSave()}
            />
          ) : null
        }
      />

      {loadError ? (
        <StateView
          icon={AlertCircle}
          title="Couldn't open this desktop"
          message={loadError}
          primary={{ label: 'Go back', onPress: leave }}
        />
      ) : !host ? (
        <StateView loading title="Loading desktop…" />
      ) : (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={hostOs() === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + spacing.xl }]}
            keyboardShouldPersistTaps="handled"
          >
            <TextField
              label="Name"
              accessibilityLabel="Name"
              value={name}
              onChangeText={(value) => {
                setName(value)
                setSaveError(null)
              }}
              placeholder={host.lastKnownMachineName ?? 'Desktop name'}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="next"
              footnote="Leave empty to use the name the desktop reports."
            />

            <View style={styles.addressBlock}>
              <TextField
                label="Address"
                accessibilityLabel="Address"
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
                error={addressInvalid !== null}
                footnote={addressInvalid ?? 'An IP, host:port, or a ws:// or wss:// URL.'}
              />
              {endpointEdit != null && endpointEdit.kind !== 'invalid' ? (
                <Text style={styles.preview} numberOfLines={2}>
                  Connects to {endpointEdit.endpoint}
                </Text>
              ) : null}
              <Text style={styles.hint}>
                Changing the address switches where this phone connects. It does not re-pair.
              </Text>
            </View>

            {saveError ? (
              <View style={styles.bannerBleed}>
                <Banner tone="error" title="Couldn't save" message={saveError} />
              </View>
            ) : null}
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
  form: {
    width: '100%',
    maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    gap: spacing.xl
  },
  // The banner insets itself for the canvas; the form already has.
  bannerBleed: {
    marginHorizontal: -spacing.lg
  },
  addressBlock: {
    gap: spacing.sm
  },
  preview: {
    ...textStyles.footnote,
    paddingLeft: 4,
    color: colors.textSecondary,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : typography.monoFamily
  },
  hint: {
    ...textStyles.footnote,
    paddingLeft: 4,
    color: colors.textMuted
  }
})
