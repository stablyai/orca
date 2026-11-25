// The shares offered to each paired computer's account, at the top of the Bots tab: who shared what,
// with Accept and Decline. The phone answers through that computer; accepted, the agent's own row
// takes its place once the computer pairs it.
import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { Users } from 'lucide-react-native'
import type { SharedBotPhoneRequest } from '../../../../src/shared/bots/bot-share-phone'
import { botFallback } from '../../../../src/shared/bots/bot-avatar-fallback'
import { MobileBotAvatar } from '../../bots/MobileBotAvatar'
import { phoneSharedAgents } from '../../bots/shared-agents/phone-shared-agents'
import { watchPhoneSharedAgents } from '../../bots/shared-agents/phone-shared-agent-watch'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, feedback, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

type HostRequest = { pairedHostId: string; request: SharedBotPhoneRequest }

/** Every paired computer's requests, followed as their lists change. */
export function useSharedAgentRequests(hostIds: readonly string[]): readonly HostRequest[] {
  const [byHost, setByHost] = useState<ReadonlyMap<string, readonly SharedBotPhoneRequest[]>>(
    new Map()
  )
  const key = hostIds.join('\n')
  useEffect(() => {
    const agents = phoneSharedAgents()
    const stops = key
      .split('\n')
      .filter(Boolean)
      .map((hostId) =>
        watchPhoneSharedAgents(
          agents,
          () => agents.requests(hostId),
          (next) => setByHost((shown) => new Map(shown).set(hostId, next))
        )
      )
    return () => stops.forEach((stop) => stop())
  }, [key])
  return useMemo(
    () =>
      [...byHost].flatMap(([pairedHostId, requests]) =>
        requests.map((request) => ({ pairedHostId, request }))
      ),
    [byHost]
  )
}

/** The name a request calls its owner by: their first name. */
function ownerShortName(ownerName: string): string {
  return ownerName.trim().split(/\s+/)[0] ?? ownerName
}

function RequestRow({ pairedHostId, request, divider }: HostRequest & { divider: boolean }) {
  const t = useMobileTranslation()
  const [answering, setAnswering] = useState(false)
  const answer = async (accept: boolean): Promise<void> => {
    setAnswering(true)
    const done = await phoneSharedAgents().answerRequest(pairedHostId, request.shareId, accept)
    if (!done) {
      setAnswering(false)
      Alert.alert(t('bots.share.requestFailed', 'Couldn’t answer the request. Try again.'))
    }
  }
  const avatar = request.avatarUrl
    ? ({ kind: 'image', uri: request.avatarUrl } as const)
    : ({ kind: 'text', text: botFallback({ name: request.botName, avatar: null }) } as const)
  return (
    <View style={styles.row}>
      {divider ? <View style={styles.divider} /> : null}
      <MobileBotAvatar avatar={avatar} size={32} />
      <View style={styles.main}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={styles.title}>
            {request.botName}
          </Text>
          <Users
            size={12}
            color={colors.textMuted}
            accessibilityLabel={t('bots.share.sharedBy', 'Shared by {{name}}', {
              name: request.ownerName
            })}
          />
        </View>
        <Text numberOfLines={1} style={styles.line}>
          {t('bots.share.requestLine', '{{owner}} shared {{agent}} with you', {
            owner: ownerShortName(request.ownerName),
            agent: request.botName
          })}
        </Text>
        {request.botPurpose ? (
          <Text numberOfLines={1} style={styles.line}>
            {request.botPurpose}
          </Text>
        ) : null}
        <View style={styles.buttons}>
          {answering ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                onPress={() => void answer(true)}
                style={({ pressed }) => [styles.button, styles.primary, pressed && styles.pressed]}
              >
                <Text style={[styles.buttonText, styles.primaryText]}>
                  {t('bots.share.accept', 'Accept')}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => void answer(false)}
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
              >
                <Text style={styles.buttonText}>{t('bots.share.decline', 'Decline')}</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </View>
  )
}

/** The requests first in the Bots tab; nothing when there are none. */
export function MobileSharedAgentRequestRows({ requests }: { requests: readonly HostRequest[] }) {
  useMobileColorScheme()
  return requests.map(({ pairedHostId, request }, index) => (
    <RequestRow
      key={`${pairedHostId}:${request.shareId}`}
      pairedHostId={pairedHostId}
      request={request}
      divider={index > 0}
    />
  ))
}

const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 64
  },
  divider: {
    position: 'absolute',
    top: 0,
    right: 0,
    left: spacing.lg + 32 + spacing.md,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle
  },
  main: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { flexShrink: 1, fontSize: 15, color: colors.textSecondary, fontWeight: '500' },
  line: { marginTop: 3, fontSize: 13, color: colors.textMuted },
  buttons: { flexDirection: 'row', gap: spacing.sm, marginTop: 10 },
  button: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  primary: { backgroundColor: colors.surfaceBright },
  buttonText: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  primaryText: { color: colors.bgBase },
  pressed: { opacity: feedback.pressedOpacity }
}))
