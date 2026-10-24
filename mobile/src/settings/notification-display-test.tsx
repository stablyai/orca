import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { loadPushNotificationsEnabled } from '../storage/preferences'
import { useAllHostClients } from '../transport/use-all-host-clients'
import { loadHostCatalog } from '../transport/host-store'
import { pushDeliveryTest } from '../notifications/mobile-push-delivery-test-operations'
import { sendLocalNotificationDisplayTest } from '../notifications/push-socket-fallback'
import { getDevicePushToken } from '../notifications/push-token'
import type { RpcFailure } from '../transport/types'
import { colors, spacing, typography } from '../theme/mobile-theme'

const TOKEN_PROBE_TIMEOUT_MS = 1500

async function readPushTokenQuickly(): Promise<
  Awaited<ReturnType<typeof getDevicePushToken>> | 'timeout'
> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      getDevicePushToken().catch(() => null),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), TOKEN_PROBE_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

export function NotificationDisplayTest({ onTroubleshoot }: { onTroubleshoot: () => void }) {
  const busy = useRef(false)
  const [hostIds, setHostIds] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const clients = useAllHostClients(hostIds)
  useEffect(() => {
    void loadHostCatalog()
      .then((hosts) => setHostIds(hosts.map((host) => host.id)))
      .catch(() => setMessage('Could not load paired desktops.'))
  }, [])
  const run = async () => {
    if (busy.current) {
      return
    }
    busy.current = true
    setSending(true)
    setMessage(null)
    try {
      if (hostIds.length === 0) {
        throw new Error('Pair a desktop and try again.')
      }
      const connected = clients.filter((entry) => entry.state === 'connected')
      if (connected.length === 0) {
        throw new Error('Connect a desktop and try again.')
      }
      let unavailable = 'Update your desktop to run this test.'
      let sawNotRegistered = false
      for (const { client } of connected) {
        const reply = await pushDeliveryTest.request(client, null, {
          timeoutMs: 20000,
          failWhenDisconnected: true
        })
        const delivered = pushDeliveryTest.interpret(reply)
        if (!delivered.accepted) {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this policy skips only a refusal, so an unaccepted reply is a failure envelope.
          const code = (reply as RpcFailure).error?.code
          if (code === 'forbidden' || code === 'method_not_found') {
            continue
          }
          throw new Error('Could not reach the desktop. Try again.')
        }
        const result = delivered.value
        if (result?.accepted) {
          setMessage('Accepted by Orca’s push service. Check for the notification.')
          return
        }
        if (result?.reason === 'not_registered') {
          sawNotRegistered = true
          unavailable = 'Reconnect to register this phone for notifications.'
          continue
        }
        throw new Error(
          result?.reason === 'rate_limited'
            ? 'Too many notifications. Try again later.'
            : 'Could not send through Orca’s push service. Try again.'
        )
      }
      if (
        sawNotRegistered &&
        (await loadPushNotificationsEnabled()) &&
        (await readPushTokenQuickly()) === null
      ) {
        await sendLocalNotificationDisplayTest()
        setMessage(
          'Sent a local test notification. Live connection alerts are active on this device.'
        )
        return
      }
      throw new Error(unavailable)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not send push test.')
    } finally {
      busy.current = false
      setSending(false)
    }
  }
  return (
    <View style={styles.container}>
      <Text style={styles.label}>Having trouble receiving alerts?</Text>
      <Text style={styles.detail}>Send a test through Orca’s push service.</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={sending ? 'Sending…' : 'Send test notification'}
        disabled={sending}
        accessibilityState={{ disabled: sending }}
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        onPress={() => void run()}
      >
        <Text accessible={false} style={styles.buttonText}>
          {sending ? 'Sending…' : 'Send test notification'}
        </Text>
      </Pressable>
      <Pressable accessibilityRole="link" onPress={onTroubleshoot} style={styles.troubleshootLink}>
        <Text style={styles.linkText}>Troubleshooting</Text>
      </Pressable>
      {message && (
        <Text accessibilityRole="alert" style={styles.detail}>
          {message}
        </Text>
      )}
    </View>
  )
}
const styles = StyleSheet.create({
  container: { marginTop: spacing.xl, gap: spacing.sm },
  label: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  detail: { color: colors.textMuted, fontSize: typography.metaSize, lineHeight: 18 },
  button: {
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 172,
    backgroundColor: colors.bgRaised,
    borderRadius: 8,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md
  },
  troubleshootLink: { alignSelf: 'flex-start', paddingVertical: spacing.sm },
  linkText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    textDecorationLine: 'underline'
  },
  pressed: { opacity: 0.6 },
  buttonText: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '600' }
})
