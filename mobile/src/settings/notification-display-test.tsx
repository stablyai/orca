import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useAllHostClients } from '../transport/use-all-host-clients'
import { loadHostCatalog } from '../transport/host-store'
import { pushDeliveryTest } from '../notifications/mobile-push-delivery-test-operations'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export function NotificationDisplayTest({ onTroubleshoot }: { onTroubleshoot: () => void }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const busy = useRef(false)
  const [hostIds, setHostIds] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const clients = useAllHostClients(hostIds)
  useEffect(() => {
    void loadHostCatalog()
      .then((hosts) => setHostIds(hosts.map((host) => host.id)))
      .catch(() =>
        setMessage(
          t('settings.notificationDisplayTest.loadFailed', 'Could not load paired desktops.')
        )
      )
  }, [t])
  const run = async () => {
    if (busy.current) {
      return
    }
    busy.current = true
    setSending(true)
    setMessage(null)
    try {
      if (hostIds.length === 0) {
        throw new Error(
          t('settings.notificationDisplayTest.pairDesktop', 'Pair a desktop and try again.')
        )
      }
      const connected = clients.filter((entry) => entry.state === 'connected')
      if (connected.length === 0) {
        throw new Error(
          t('settings.notificationDisplayTest.connectDesktop', 'Connect a desktop and try again.')
        )
      }
      let unavailable = t(
        'settings.notificationDisplayTest.updateDesktop',
        'Update your desktop to run this test.'
      )
      for (const { client } of connected) {
        const reply = await pushDeliveryTest.request(client, null, {
          timeoutMs: 20000,
          failWhenDisconnected: true
        })
        const delivered = pushDeliveryTest.interpret(reply)
        if (!delivered.accepted) {
          const code = reply.ok ? undefined : reply.error?.code
          if (code === 'forbidden' || code === 'method_not_found') {
            continue
          }
          throw new Error(
            t(
              'settings.notificationDisplayTest.desktopUnreachable',
              'Could not reach the desktop. Try again.'
            )
          )
        }
        const result = delivered.value
        if (result?.accepted) {
          setMessage(
            t(
              'settings.notificationDisplayTest.accepted',
              'Accepted by Orca’s push service. Check for the notification.'
            )
          )
          return
        }
        if (result?.reason === 'not_registered') {
          unavailable = t(
            'settings.notificationDisplayTest.reconnectPhone',
            'Reconnect to register this phone for notifications.'
          )
          continue
        }
        throw new Error(
          result?.reason === 'rate_limited'
            ? t(
                'settings.notificationDisplayTest.rateLimited',
                'Too many notifications. Try again later.'
              )
            : t(
                'settings.notificationDisplayTest.pushServiceFailed',
                'Could not send through Orca’s push service. Try again.'
              )
        )
      }
      throw new Error(unavailable)
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : t('settings.notificationDisplayTest.sendFailed', 'Could not send push test.')
      )
    } finally {
      busy.current = false
      setSending(false)
    }
  }
  return (
    <View style={styles.container}>
      <Text style={styles.label}>
        {t(
          'settings.notificationDisplayTest.troubleReceivingAlerts',
          'Having trouble receiving alerts?'
        )}
      </Text>
      <Text style={styles.detail}>
        {t(
          'settings.notificationDisplayTest.description',
          'Send a test through Orca’s push service.'
        )}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          sending
            ? t('settings.notificationDisplayTest.sending', 'Sending…')
            : t('settings.notificationDisplayTest.sendButton', 'Send test notification')
        }
        disabled={sending}
        accessibilityState={{ disabled: sending }}
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        onPress={() => void run()}
      >
        <View>
          <Text accessible={false} style={[styles.buttonText, styles.sizingLabel]}>
            {t('settings.notificationDisplayTest.sendButton', 'Send test notification')}
          </Text>
          <View pointerEvents="none" style={styles.buttonLabel}>
            <Text accessible={false} style={styles.buttonText}>
              {sending
                ? t('settings.notificationDisplayTest.sending', 'Sending…')
                : t('settings.notificationDisplayTest.sendButton', 'Send test notification')}
            </Text>
          </View>
        </View>
      </Pressable>
      <Pressable accessibilityRole="link" onPress={onTroubleshoot} style={styles.troubleshootLink}>
        <Text style={styles.linkText}>
          {t('settings.notificationDisplayTest.troubleshooting', 'Troubleshooting')}
        </Text>
      </Pressable>
      {message && (
        <Text accessibilityRole="alert" style={styles.detail}>
          {message}
        </Text>
      )}
    </View>
  )
}
const styles = themedStyleSheet(() => ({
  container: { marginTop: spacing.xl, gap: spacing.sm },
  label: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  detail: { color: colors.textMuted, fontSize: typography.metaSize, lineHeight: 18 },
  button: {
    alignSelf: 'flex-start',
    backgroundColor: colors.bgRaised,
    borderRadius: 8,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md
  },
  sizingLabel: { opacity: 0 },
  buttonLabel: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center'
  },
  troubleshootLink: { alignSelf: 'flex-start', paddingVertical: spacing.sm },
  linkText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    textDecorationLine: 'underline'
  },
  pressed: { opacity: 0.6 },
  buttonText: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '600' }
}))
