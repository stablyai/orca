import { SshConnectionFields } from '../src/ssh/SshConnectionFields'
import { importSshPrivateKey } from '../src/ssh/import-ssh-private-key'
import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft } from 'lucide-react-native'
import { ConnectionLog } from '../src/components/ConnectionLog'
import { probeSshHost } from '../src/transport/ssh-route-native'
import { readSshRouteCredentials } from '../src/transport/ssh-route-credentials'
import { cleanupSshCredentials } from '../src/transport/host-connection-route-store'
import type { ConnectionLogEntry } from '../src/transport/types'
import { emptySshConnectionForm, type SshConnectionForm } from '../src/ssh/ssh-connection-form'
import { assertNoJumpCycle, parseSshProfileForm, type SshProfile } from '../src/ssh/ssh-profile'
import { deleteSshProfile, loadSshProfiles } from '../src/ssh/ssh-profile-store'
import { saveSshProfileWithTest } from '../src/ssh/save-ssh-profile'
import { randomUUID } from 'expo-crypto'
import { sshConnectionStyles as styles } from '../src/ssh/ssh-connection-styles'
import { colors, spacing } from '../src/theme/mobile-theme'

export default function SshConnectionScreen() {
  const router = useRouter()
  const { profileId } = useLocalSearchParams<{ profileId?: string }>()
  const insets = useSafeAreaInsets()
  const [form, setForm] = useState<SshConnectionForm>(emptySshConnectionForm)
  const [profiles, setProfiles] = useState<SshProfile[]>([])
  const [profile, setProfile] = useState<SshProfile | null>(null)
  const [loading, setLoading] = useState(Boolean(profileId))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [logs, setLogs] = useState<ConnectionLogEntry[]>([])
  const active = useRef<AbortController | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    let current = true
    void loadSshProfiles()
      .then((entries) => {
        if (current) {
          setProfiles(entries)
        }
      })
      .catch(() => {})
    if (profileId) {
      void loadSshProfiles()
        .then(async (profiles) => {
          const found = profiles.find((entry) => entry.id === profileId)
          if (!found) {
            throw new Error('SSH connection was removed from this phone.')
          }
          if (!current) {
            return
          }
          setProfile(found)
          setForm((value) => ({
            ...value,
            name: found.name,
            host: found.host,
            port: String(found.port),
            username: found.username,
            targetHost: found.targetHost,
            targetPort: found.targetPort === undefined ? '' : String(found.targetPort),
            hostKeyFingerprint: found.hostKeyFingerprint,
            jumpProfileId: found.jumpProfileId ?? ''
          }))
          const secret = await readSshRouteCredentials(found.id)
          if (current) {
            setForm((value) => ({
              ...value,
              auth: secret.kind,
              ...(secret.kind === 'password'
                ? { password: secret.password }
                : { privateKey: secret.privateKey, passphrase: secret.passphrase })
            }))
          }
        })
        .catch((reason: unknown) => {
          if (current) {
            setError(reason instanceof Error ? reason.message : 'Cannot load SSH settings.')
          }
        })
        .finally(() => {
          if (current) {
            setLoading(false)
          }
        })
    }
    return () => {
      current = false
      mounted.current = false
      active.current?.abort()
    }
  }, [profileId])

  function change(field: keyof SshConnectionForm, value: string) {
    setForm((previous) => ({
      ...previous,
      [field]: value,
      ...(field === 'host' || field === 'port' ? { hostKeyFingerprint: '' } : {})
    }))
    setError('')
  }

  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    if (active.current) {
      return
    }
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setError('')
    try {
      await operation(controller.signal)
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : 'SSH connection failed.')
      }
    } finally {
      if (active.current === controller) {
        active.current = null
      }
      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  async function verify(signal: AbortSignal) {
    if (
      !form.host.trim() ||
      !/^\d+$/.test(form.port) ||
      Number(form.port) < 1 ||
      Number(form.port) > 65535
    ) {
      throw new Error('Enter the SSH hostname and port first.')
    }
    // The jump profile was verified when it was saved; its stored credentials
    // reach the server for the fingerprint probe.
    const jump = profiles.find((entry) => entry.id === form.jumpProfileId)
    let jumpProbe
    if (jump) {
      const secret = await readSshRouteCredentials(jump.id)
      jumpProbe = {
        host: jump.host,
        port: jump.port,
        username: jump.username,
        hostKeyFingerprint: jump.hostKeyFingerprint,
        ...(secret.kind === 'password'
          ? { password: secret.password }
          : { privateKey: secret.privateKey, passphrase: secret.passphrase })
      }
    }
    const { fingerprint } = await probeSshHost(
      form.host.trim(),
      Number(form.port),
      signal,
      jumpProbe
    )
    if (!mounted.current || signal.aborted) {
      return
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        signal.removeEventListener('abort', finish)
        resolve()
      }
      signal.addEventListener('abort', finish, { once: true })
      Alert.alert(
        'Verify SSH host key',
        `${form.host}:${form.port}\n\n${fingerprint}\n\nCompare this fingerprint with your server through a trusted channel before trusting it.`,
        [
          { text: 'Cancel', style: 'cancel', onPress: finish },
          {
            text: 'Trust this key',
            onPress: () => {
              if (mounted.current && !signal.aborted) {
                setForm((value) => ({ ...value, hostKeyFingerprint: fingerprint }))
              }
              finish()
            }
          }
        ],
        { cancelable: true, onDismiss: finish }
      )
    })
  }

  async function save(signal: AbortSignal) {
    setLogs([])
    const { profile: parsed, credentials } = parseSshProfileForm(form, profile?.id ?? randomUUID())
    assertNoJumpCycle(parsed, profiles)
    const jumpProfile = profiles.find((entry) => entry.id === parsed.jumpProfileId)
    await saveSshProfileWithTest({
      profile: parsed,
      jumpProfile,
      credentials,
      signal,
      onLog: (entry) => {
        if (mounted.current) {
          setLogs((entries) => [...entries.slice(-99), entry])
        }
      }
    })
    if (mounted.current && !signal.aborted) {
      router.back()
    }
  }

  async function performDelete() {
    if (!profile) {
      return
    }
    await deleteSshProfile(profile.id)
    await cleanupSshCredentials().catch(() => {})
    if (mounted.current) {
      router.back()
    }
  }

  async function remove() {
    if (!profile) {
      return
    }
    const dependents = profiles.filter((entry) => entry.jumpProfileId === profile.id)
    if (dependents.length > 0) {
      const names = dependents.map((entry) => entry.name).join(', ')
      const confirmed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          'Delete SSH connection?',
          `${names} use it as their jump host and will connect directly afterwards.`,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            {
              text: 'Delete',
              style: 'destructive',
              onPress: () => resolve(true)
            }
          ],
          { cancelable: true, onDismiss: () => resolve(false) }
        )
      })
      if (!confirmed) {
        return
      }
    }
    await performDelete()
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.back}
          onPress={() => {
            active.current?.abort()
            router.back()
          }}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.title}>{profileId ? 'Edit SSH connection' : 'Add SSH connection'}</Text>
      </View>
      <ScrollView
        contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + spacing.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.help}>
          Orca connects to this SSH server, then the server opens the socket connection itself.
          Choose it as the connection route when pairing with a computer.
        </Text>
        <SshConnectionFields
          form={form}
          profiles={profiles}
          selfId={profile?.id}
          disabled={busy || loading}
          change={change}
          verify={() => void run(verify)}
          importKey={() =>
            void run(async (signal) => {
              const text = await importSshPrivateKey(signal)
              if (text !== null && mounted.current) {
                change('privateKey', text)
              }
            })
          }
        />
        <Text style={styles.help}>
          Credentials are saved in this device’s secure storage. Orca verifies the SSH host key and
          keeps its existing pairing encryption inside the tunnel.
        </Text>
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {logs.length > 0 && <ConnectionLog entries={logs} title="SSH connection log" />}
        <Pressable
          accessibilityRole="button"
          disabled={busy || loading}
          style={[styles.button, (busy || loading) && styles.disabled]}
          onPress={() => void run(save)}
        >
          {busy || loading ? (
            <ActivityIndicator color={colors.bgBase} />
          ) : (
            <Text style={styles.buttonText}>Test and save connection</Text>
          )}
        </Pressable>
        {profile && (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            style={styles.secondary}
            onPress={() =>
              void run(async () => {
                await remove()
              })
            }
          >
            <Text style={styles.secondaryText}>Delete this SSH connection</Text>
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
