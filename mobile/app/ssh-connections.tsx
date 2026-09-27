import { useCallback, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft } from 'lucide-react-native'
import { ConnectionLog } from '../src/components/ConnectionLog'
import { loadHosts } from '../src/transport/host-store'
import { useRefreshHostClient } from '../src/transport/client-context'
import type { ConnectionLogEntry, HostProfile } from '../src/transport/types'
import { applySshProfileToHost } from '../src/ssh/apply-ssh-profile'
import { loadSshProfiles } from '../src/ssh/ssh-profile-store'
import type { SshProfile } from '../src/ssh/ssh-profile'
import { sshConnectionStyles as styles } from '../src/ssh/ssh-connection-styles'
import { colors, spacing } from '../src/theme/mobile-theme'

export default function SshConnectionsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId?: string }>()
  const refresh = useRefreshHostClient()
  const [profiles, setProfiles] = useState<SshProfile[]>([])
  const [host, setHost] = useState<HostProfile | null>(null)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [logs, setLogs] = useState<ConnectionLogEntry[]>([])
  const active = useRef<AbortController | null>(null)
  const mounted = useRef(true)

  useFocusEffect(
    useCallback(() => {
      mounted.current = true
      let current = true
      void loadSshProfiles()
        .then((entries) => {
          if (current) {
            setProfiles(entries)
          }
        })
        .catch(() => {
          if (current) {
            setError('Cannot load SSH connections.')
          }
        })
      if (hostId) {
        void loadHosts()
          .then((hosts) => {
            if (current) {
              const found = hosts.find((entry) => entry.id === hostId)
              if (found) {
                setHost(found)
              } else {
                setError('Host was removed from this phone.')
              }
            }
          })
          .catch(() => {
            if (current) {
              setError('Cannot load the host.')
            }
          })
      }
      return () => {
        current = false
        mounted.current = false
        active.current?.abort()
      }
    }, [hostId])
  )

  function apply(profile: SshProfile) {
    if (!host || applyingId) {
      return
    }
    const controller = new AbortController()
    active.current = controller
    setApplyingId(profile.id)
    setError('')
    setLogs([])
    const jumpProfile = profile.jumpProfileId
      ? profiles.find((entry) => entry.id === profile.jumpProfileId)
      : undefined
    void applySshProfileToHost({
      host,
      profile,
      jumpProfile,
      signal: controller.signal,
      onLog: (entry) => {
        if (mounted.current) {
          setLogs((entries) => [...entries.slice(-99), entry])
        }
      }
    })
      .then(() => {
        if (mounted.current && !controller.signal.aborted) {
          refresh(host.id)
          router.back()
        }
      })
      .catch((reason: unknown) => {
        if (mounted.current && !controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'SSH connection failed.')
        }
      })
      .finally(() => {
        // Why: a blur during the apply must not leave the row disabled forever.
        if (active.current === controller) {
          active.current = null
          setApplyingId(null)
        }
      })
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
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
        <Text style={styles.title}>SSH connections</Text>
      </View>
      <ScrollView
        contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + spacing.xl }]}
      >
        <Text style={styles.help}>
          {host
            ? 'Choose a saved SSH connection to use when reaching this computer.'
            : 'Saved SSH connections are offered as the connection route when pairing with a computer.'}
        </Text>
        {profiles.length === 0 && !error ? (
          <Text style={styles.label}>No SSH connections saved yet.</Text>
        ) : null}
        {profiles.map((profile) => (
          <Pressable
            key={profile.id}
            accessibilityRole="button"
            style={styles.input}
            disabled={Boolean(applyingId)}
            onPress={() =>
              host
                ? apply(profile)
                : router.push({ pathname: '/ssh-connection', params: { profileId: profile.id } })
            }
          >
            {applyingId === profile.id ? (
              <ActivityIndicator color={colors.textSecondary} />
            ) : (
              <>
                <Text style={styles.profileName}>{profile.name}</Text>
                <Text style={styles.profileDetail}>
                  {profile.username}@{profile.host}:{profile.port}
                  {` → ${profile.targetHost}:${profile.targetPort ?? 'pairing port'}`}
                </Text>
                <Text style={styles.profileDetail}>{profile.hostKeyFingerprint}</Text>
              </>
            )}
          </Pressable>
        ))}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {logs.length > 0 && <ConnectionLog entries={logs} title="SSH connection log" />}
        <Pressable
          accessibilityRole="button"
          style={styles.button}
          disabled={Boolean(applyingId)}
          onPress={() => router.push('/ssh-connection')}
        >
          <Text style={styles.buttonText}>Add SSH connection</Text>
        </Pressable>
      </ScrollView>
    </View>
  )
}
