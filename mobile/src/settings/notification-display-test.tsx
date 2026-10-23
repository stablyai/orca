import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Send, Wrench } from 'lucide-react-native'
import { useAllHostClients } from '../transport/use-all-host-clients'
import { loadHostCatalog } from '../transport/host-store'
import { pushDeliveryTest } from '../notifications/mobile-push-delivery-test-operations'
import type { RpcFailure } from '../transport/types'
import { spacing } from '../theme/mobile-theme'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { Button } from '../components/ui/Button'
import { ListGroup, LIST_LEADING_INSET } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { SectionHeader } from '../components/ui/SectionHeader'
import { SettingsFooter, SettingsRowIcon, type SettingsTone } from './settings-screen-frame'

type TestResult = { tone: SettingsTone; text: string }

export function NotificationDisplayTest({ onTroubleshoot }: { onTroubleshoot: () => void }) {
  const busy = useRef(false)
  const [hostIds, setHostIds] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState<TestResult | null>(null)
  const clients = useAllHostClients(hostIds)
  useEffect(() => {
    void loadHostCatalog()
      .then((hosts) => setHostIds(hosts.map((host) => host.id)))
      .catch(() => setMessage({ tone: 'error', text: 'Could not load paired desktops.' }))
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
          triggerSuccess()
          setMessage({
            tone: 'success',
            text: 'Accepted by Orca’s push service. Check for the notification.'
          })
          return
        }
        if (result?.reason === 'not_registered') {
          unavailable = 'Reconnect to register this phone for notifications.'
          continue
        }
        throw new Error(
          result?.reason === 'rate_limited'
            ? 'Too many notifications. Try again later.'
            : 'Could not send through Orca’s push service. Try again.'
        )
      }
      throw new Error(unavailable)
    } catch (error) {
      triggerError()
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Could not send push test.'
      })
    } finally {
      busy.current = false
      setSending(false)
    }
  }
  return (
    <>
      <SectionHeader title="Test delivery" />
      <View style={styles.action}>
        <Button
          label="Send test notification"
          icon={Send}
          variant="secondary"
          block
          busy={sending}
          accessibilityLabel={sending ? 'Sending…' : 'Send test notification'}
          onPress={() => void run()}
        />
      </View>
      {message ? (
        <View accessibilityRole="alert">
          <SettingsFooter tone={message.tone}>{message.text}</SettingsFooter>
        </View>
      ) : (
        <SettingsFooter>Sends a test through Orca’s push service.</SettingsFooter>
      )}
      <View style={styles.troubleshoot}>
        <ListGroup separatorInset={LIST_LEADING_INSET}>
          <ListRow
            title="Troubleshooting"
            leading={<SettingsRowIcon icon={Wrench} />}
            navigates
            onPress={onTroubleshoot}
          />
        </ListGroup>
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  action: { paddingHorizontal: spacing.lg },
  troubleshoot: { marginTop: spacing.xl }
})
