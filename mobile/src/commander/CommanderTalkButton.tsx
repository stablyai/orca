import { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { MessageCircle } from 'lucide-react-native'
import { PickerModal } from '../components/sheets/PickerModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { hostStackRouteHref } from '../navigation/host-stack-navigation'
import { useRouteHandoff } from '../navigation/route-handoff'
import { mobileSessionRouteTarget } from '../session/mobile-session-route'
import { useOpenMobileSession } from '../session/use-open-mobile-session'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { isMobileMethodUnavailableError } from '../transport/rpc/mobile-method-unavailable'
import type { CommanderMobileData } from './commander-mobile-data'
import { openCommanderConversation } from './open-commander-conversation'

export function CommanderTalkButton({
  data,
  hostScoped
}: {
  data: CommanderMobileData
  hostScoped?: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const openSession = useOpenMobileSession()
  const handoff = useRouteHandoff()
  const [selecting, setSelecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const lifetime = useRef<AbortSignal | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller.signal
    return () => controller.abort()
  }, [])
  const connected = (id: string) =>
    data.hostStates[id] === 'connected' && data.allClients.some((entry) => entry.hostId === id)
  const available = data.sortedHosts.some((host) => connected(host.id))
  const offline = t('commander.chatOffline', 'Connect to your desktop to talk to Commander.')
  async function open(id: string) {
    setSelecting(false)
    const client = data.allClients.find((entry) => entry.hostId === id)?.client
    const signal = lifetime.current
    if (inFlight.current || !signal || signal.aborted) {
      return
    }
    if (!client || client.getState() !== 'connected') {
      setError(offline)
      return
    }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const target = await openCommanderConversation(client, signal)
      if (!signal.aborted) {
        const session = {
          hostId: id,
          worktreeId: target.worktreeId,
          paneKey: target.paneKey,
          name: target.name
        }
        if (hostScoped) {
          handoff.push(hostStackRouteHref(mobileSessionRouteTarget(session)))
        } else {
          openSession({ ...session, standalone: true })
        }
      }
    } catch (cause) {
      if (!signal.aborted) {
        const message = cause instanceof Error ? cause.message : String(cause)
        const code = message.split(':', 1)[0]
        if (isMobileMethodUnavailableError(code === 'forbidden' ? undefined : code, message)) {
          setError(t('commander.chatUpdate', 'Update Orca on this host to open Commander chat.'))
        } else if (
          message.includes('bots_disabled') ||
          /bots (are |is )?(switched off|disabled|turned off)/i.test(message)
        ) {
          setError(t('commander.chatBots', 'Turn on Bots in Orca settings on this desktop.'))
        } else if (message === 'commander_disconnected' || client.getState() !== 'connected') {
          setError(offline)
        } else {
          setError(
            message === 'commander_chat_unavailable'
              ? t(
                  'commander.chatUnavailable',
                  'Could not open the Commander conversation. Try again.'
                )
              : message
          )
        }
      }
    }
    inFlight.current = false
    if (!signal.aborted) {
      setBusy(false)
    }
  }
  const disabled = !available || busy
  const label = busy
    ? t('commander.chatOpening', 'Opening chat…')
    : t('commander.chatTalk', 'Talk to Commander')
  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled, busy }}
        accessibilityLabel={label}
        disabled={disabled}
        style={({ pressed }) => [styles.button, (disabled || pressed) && styles.dim]}
        onPress={() => {
          if (data.sortedHosts.length === 1) {
            void open(data.sortedHosts[0].id)
          } else {
            setSelecting(true)
          }
        }}
      >
        <MessageCircle color={colors.bgBase} size={18} />
        <Text style={styles.label}>{label}</Text>
      </Pressable>
      {error || !available ? (
        <Text accessibilityRole="alert" style={styles.detail}>
          {available ? error : offline}
        </Text>
      ) : null}
      <PickerModal
        visible={selecting}
        title={t('commander.memoryDesktop', 'Choose desktop')}
        selected=""
        searchable={data.sortedHosts.length > 6}
        options={data.sortedHosts.map((host) => ({
          value: host.id,
          label: host.name,
          disabled: !connected(host.id),
          subtitle: connected(host.id) ? undefined : t('agents.desktops.offline', 'Offline')
        }))}
        onSelect={(id) => void open(id)}
        onClose={() => setSelecting(false)}
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  container: { marginHorizontal: spacing.lg, marginTop: spacing.xs, gap: spacing.xs },
  button: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control,
    backgroundColor: colors.surfaceBright
  },
  label: { fontSize: 16, fontWeight: '600', color: colors.bgBase, flexShrink: 1 },
  detail: { fontSize: 14, color: colors.textSecondary },
  dim: { opacity: 0.55 }
}))
