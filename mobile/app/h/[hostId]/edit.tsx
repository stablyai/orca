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
import { HostAddressFields } from '../../../src/components/HostAddressFields'
import { colors, radii, spacing, typography } from '../../../src/theme/mobile-theme'
import { loadHosts, updateHostNameAndEndpoint } from '../../../src/transport/host-store'
import { displayHostEndpoint } from '../../../src/transport/host-endpoint'
import {
  resolveHostEndpointEdit,
  sameHostEndpointAuthority
} from '../../../src/transport/host-endpoint-edit'
import { isTailscaleEndpoint } from '../../../../src/shared/remote-runtime-tailscale-hint'
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
  const [alternateAddress, setAlternateAddress] = useState('')
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
      const alternate = found.endpoints?.find(
        ({ kind, url }) => kind !== 'relay' && !sameHostEndpointAuthority(url, found.endpoint)
      )
      setAlternateAddress(alternate ? displayHostEndpoint(alternate.url) : '')
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load host.')
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
  const storedAlternateEndpoint = useMemo(
    () =>
      host?.endpoints?.find(
        ({ kind, url }) => kind !== 'relay' && !sameHostEndpointAuthority(url, host.endpoint)
      )?.url,
    [host]
  )
  const alternateEndpointEdit = useMemo(() => {
    if (!host || !alternateAddress.trim()) {
      return null
    }
    return resolveHostEndpointEdit(storedAlternateEndpoint ?? host.endpoint, alternateAddress)
  }, [alternateAddress, host, storedAlternateEndpoint])

  const nameTrimmed = name.trim()
  const nameChanged = host != null && nameTrimmed.length > 0 && nameTrimmed !== host.name
  const endpointChanged = endpointEdit?.kind === 'changed'
  const alternateEndpoint =
    alternateEndpointEdit && alternateEndpointEdit.kind !== 'invalid'
      ? alternateEndpointEdit.endpoint
      : null
  const alternateChanged =
    (storedAlternateEndpoint == null && alternateEndpoint != null) ||
    (storedAlternateEndpoint != null &&
      (alternateEndpoint == null ||
        !sameHostEndpointAuthority(storedAlternateEndpoint, alternateEndpoint)))
  const duplicateAddresses =
    endpointEdit != null &&
    endpointEdit.kind !== 'invalid' &&
    alternateEndpoint != null &&
    sameHostEndpointAuthority(endpointEdit.endpoint, alternateEndpoint)
  const addressesChanged = endpointChanged || alternateChanged
  const canSave =
    host != null &&
    endpointEdit != null &&
    nameTrimmed.length > 0 &&
    endpointEdit.kind !== 'invalid' &&
    alternateEndpointEdit?.kind !== 'invalid' &&
    !duplicateAddresses &&
    (nameChanged || addressesChanged) &&
    !saving

  async function handleSave() {
    if (!host || !hostId || !endpointEdit || savingRef.current) {
      return
    }
    const nextName = name.trim()
    if (!nextName) {
      setSaveError('Enter a name.')
      return
    }
    if (endpointEdit.kind === 'invalid') {
      setSaveError(endpointEdit.error)
      return
    }
    if (alternateEndpointEdit?.kind === 'invalid') {
      setSaveError(alternateEndpointEdit.error)
      return
    }
    if (duplicateAddresses) {
      setSaveError('Use a different alternate address.')
      return
    }

    const willRename = nextName !== host.name
    const nextEndpoint = endpointEdit.kind === 'changed' ? endpointEdit.endpoint : undefined
    if (!willRename && !addressesChanged) {
      router.back()
      return
    }
    const resolvedPrimaryEndpoint = nextEndpoint ?? host.endpoint
    const directEndpoints = [
      {
        id: 'direct-primary',
        kind: isTailscaleEndpoint(resolvedPrimaryEndpoint)
          ? ('tailscale' as const)
          : ('lan' as const),
        url: resolvedPrimaryEndpoint
      },
      ...(alternateEndpoint
        ? [
            {
              id: 'direct-alternate-1',
              kind: isTailscaleEndpoint(alternateEndpoint)
                ? ('tailscale' as const)
                : ('lan' as const),
              url: alternateEndpoint
            }
          ]
        : [])
    ]
    const relayEndpoints = host.endpoints?.filter(({ kind }) => kind === 'relay') ?? []

    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    try {
      // Why: a single mutateStoredHosts pass so name + endpoint commit
      // atomically — a mid-save failure can never persist one without the
      // other, and a host removed mid-edit throws instead of no-oping.
      await updateHostNameAndEndpoint(host.id, {
        ...(willRename ? { name: nextName } : {}),
        ...(nextEndpoint !== undefined ? { endpoint: nextEndpoint } : {}),
        ...(addressesChanged
          ? {
              routing: {
                endpoints: [...directEndpoints, ...relayEndpoints],
                ...(host.relayHostId ? { relayHostId: host.relayHostId } : {}),
                ...(host.relay ? { relay: host.relay } : {})
              }
            }
          : {})
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

    if (addressesChanged) {
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
              Add LAN and Tailscale addresses for the same desktop. Orca uses the first address that
              connects.
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

            <HostAddressFields
              address={address}
              alternateAddress={alternateAddress}
              alternateEndpoint={alternateEndpoint}
              alternateEndpointEdit={alternateEndpointEdit}
              canSave={canSave}
              duplicateAddresses={duplicateAddresses}
              endpointEdit={endpointEdit!}
              onAddressChange={(value) => {
                setAddress(value)
                setSaveError(null)
              }}
              onAlternateAddressChange={(value) => {
                setAlternateAddress(value)
                setSaveError(null)
              }}
              onSubmit={() => void handleSave()}
            />

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
