import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useAllHostClients } from '../transport/use-all-host-clients'
import { loadHostCatalog } from '../transport/host-store'
import { pushDeliveryTest } from '../notifications/mobile-push-delivery-test-operations'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import * as Notifications from 'expo-notifications'
import { waitForPushFallback } from '../notifications/push-fallback'
import {
  getHostPushSupported,
  getHostPushSupportCompletion
} from '../notifications/push-registration'
import { getNotificationPermissionState } from '../notifications/notification-permissions'
import { loadPushNotificationsEnabled } from '../storage/preferences'
import { loadNotificationDeliveryPreferences } from '../notifications/notification-delivery-preferences'
import {
  DESKTOP_NOTIFICATION_CHANNEL_ID,
  ensureDesktopNotificationChannel
} from '../notifications/desktop-notification-channel'

export function NotificationDisplayTest({ onTroubleshoot }: { onTroubleshoot: () => void }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const busy = useRef(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
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
    const controller = new AbortController()
    pending.current = controller
    const connected = clients
      .filter((entry) => entry.state === 'connected')
      .map((entry) => ({
        ...entry,
        support: getHostPushSupportCompletion(entry.hostId, entry.client)
      }))
    const isCurrent = () =>
      !controller.signal.aborted &&
      connected.every(
        ({ hostId, client, support }) =>
          !support?.signal.aborted && getHostPushSupportCompletion(hostId, client) === support
      )
    setSending(true)
    setMessage(null)
    const localTest = async (reason: string, liveFallback = false) => {
      const { sound } = await loadNotificationDeliveryPreferences()
      await ensureDesktopNotificationChannel()
      if (!isCurrent()) {
        return
      }
      await Notifications.scheduleNotificationAsync({
        content: {
          title: t('settings.notificationDisplayTest.localTitle', 'Test notification'),
          body: t(
            'settings.notificationDisplayTest.localBody',
            'Local notification test from this phone.'
          ),
          sound: sound ? 'default' : false
        },
        trigger: { channelId: `${DESKTOP_NOTIFICATION_CHANNEL_ID}${sound ? '' : '-silent'}` }
      })
      setMessage(
        liveFallback
          ? t(
              'settings.notificationDisplayTest.liveFallbackScheduled',
              '{{reason}} Local test scheduled. Check for the notification. Live alerts are available while Orca is running and connected.',
              { reason }
            )
          : t(
              'settings.notificationDisplayTest.localScheduled',
              '{{reason}} Local test scheduled. Check for the notification. This checks display only; it does not verify agent alert delivery.',
              { reason }
            )
      )
    }
    try {
      if (!(await loadPushNotificationsEnabled())) {
        throw new Error(
          t(
            'settings.notificationDisplayTest.disabled',
            'Notifications are turned off in Orca. Enable notifications and try again.'
          )
        )
      }
      if (!(await getNotificationPermissionState()).granted) {
        throw new Error(
          t(
            'settings.notificationDisplayTest.osDisabled',
            'Notifications are turned off in system settings. Allow notifications and try again.'
          )
        )
      }
      if (hostIds.length === 0) {
        throw new Error(
          t('settings.notificationDisplayTest.pairDesktop', 'Pair a desktop and try again.')
        )
      }
      if (connected.length === 0) {
        throw new Error(
          t('settings.notificationDisplayTest.connectDesktop', 'Connect a desktop and try again.')
        )
      }
      const unsupportedHost = t(
        'settings.notificationDisplayTest.unsupportedHost',
        'This desktop does not support push notifications. Update it to receive push.'
      )
      const fallback = connected.every(({ hostId }) => getHostPushSupported(hostId) === false)
        ? 'unsupported-host'
        : await waitForPushFallback(
            connected.map(({ support }) => support),
            controller.signal
          )
      if (!isCurrent()) {
        return
      }
      if (fallback === 'unsupported-host') {
        await localTest(unsupportedHost, true)
        return
      }
      if (fallback === 'no-token') {
        await localTest(
          t(
            'settings.notificationDisplayTest.noToken',
            'No push token is available on this phone.'
          ),
          true
        )
        return
      }
      const pushHosts = connected.filter(({ hostId }) => getHostPushSupported(hostId) !== false)
      let unavailable = unsupportedHost
      for (const { client } of pushHosts) {
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
            'settings.notificationDisplayTest.registrationPending',
            'Push registration is not ready on this desktop. Try again shortly.'
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
      await localTest(unavailable)
    } catch (error) {
      if (!isCurrent()) {
        return
      }
      setMessage(
        error instanceof Error
          ? error.message
          : t('settings.notificationDisplayTest.sendFailed', 'Could not send push test.')
      )
    } finally {
      controller.abort()
      if (pending.current === controller) {
        pending.current = null
      }
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
          'Test push delivery, or a local notification when push is unavailable.'
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
