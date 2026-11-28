// The shares offered to each paired computer's account, at the top of the Bots tab: each is the agent's
// row, dimmed, with an invite mark, and opens a sheet that explains it with Accept and Decline. The phone
// answers through that computer; accepted, the agent's own row takes its place once the computer pairs it.
import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import {
  Eye,
  KeyRound,
  Laptop,
  Lock,
  LogOut,
  Mail,
  MessageSquare,
  Moon,
  UserRound,
  Users,
  type LucideIcon
} from 'lucide-react-native'
import type { SharedBotPhoneRequest } from '../../../../src/shared/bots/bot-share-phone'
import type { AgentCardService } from '../../../../src/shared/bots/agent-card-contract'
import { agentCardAvatar, agentCardServices } from '../../../../src/shared/bots/shared-agent-card'
import { aroundOwner, ownerShortName } from '../../../../src/shared/bots/shared-bot-owner-name'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { ListGroup, ListRow } from '../../components/list/ListGroup'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import { mobileBotAvatarSource } from '../../bots/host-bot-row-facts'
import { MobileBotAvatar } from '../../bots/MobileBotAvatar'
import { MobileConnectorSourceIcon, MobileGoogleMark } from '../../bots/MobileConnectorSourceIcon'
import { phoneSharedAgents } from '../../bots/shared-agents/phone-shared-agents'
import { watchPhoneSharedAgents } from '../../bots/shared-agents/phone-shared-agent-watch'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, feedback, radii, spacing, typography } from '../../theme/mobile-theme'
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
  // A computer unpaired since keeps no rows: its requests could no longer be answered.
  return useMemo(() => {
    const paired = new Set(key.split('\n'))
    return [...byHost]
      .filter(([pairedHostId]) => paired.has(pairedHostId))
      .flatMap(([pairedHostId, requests]) => requests.map((request) => ({ pairedHostId, request })))
  }, [byHost, key])
}

const FACT_ICONS: readonly LucideIcon[] = [Laptop, MessageSquare, Lock, Eye, KeyRound, Moon, LogOut]

/** What accepting means, in the desktop invite dialog's plain lines. */
function inviteFacts(t: ReturnType<typeof useMobileTranslation>, owner: string): string[] {
  return [
    t('bots.share.invite.runsOn', '{{owner}}’s agent. It runs on {{owner}}’s computer.', { owner }),
    t('bots.share.invite.chatFrom', 'You chat with it from your Orca and your phone.'),
    t('bots.share.invite.ownChats', 'You see only your own chats.'),
    t('bots.share.invite.ownerSees', '{{owner}} can see your chats with it.', { owner }),
    t(
      'bots.share.invite.actsAs',
      'It can act on {{owner}}’s computer, with {{owner}}’s accounts.',
      {
        owner
      }
    ),
    `${t('bots.share.invite.pauses', 'It pauses while {{owner}}’s computer is off.', { owner })} ${t(
      'bots.share.invite.messagesWait',
      'Messages wait until it’s back.'
    )}`,
    t('bots.share.invite.leave', 'You can leave anytime.')
  ]
}

function requestAvatar(request: SharedBotPhoneRequest) {
  return mobileBotAvatarSource({ name: request.botName, ...agentCardAvatar(request.agentCard) })
}

function InviteSheetContent({
  request,
  onAnswer,
  onClose
}: {
  request: SharedBotPhoneRequest
  onAnswer: (accept: boolean) => void
  onClose: () => void
}) {
  const t = useMobileTranslation()
  const owner = ownerShortName(request.ownerName)
  const services = agentCardServices(request.agentCard)
  return (
    <ConfirmContent
      media={<MobileBotAvatar avatar={requestAvatar(request)} size={56} />}
      title={request.botName}
      message={t('bots.share.invite.sharedWithYou', '{{owner}} shared it with you', {
        owner: request.ownerName
      })}
      details={
        <>
          {request.botPurpose ? (
            <Text numberOfLines={4} style={styles.purpose}>
              {request.botPurpose}
            </Text>
          ) : null}
          <ListGroup>
            {inviteFacts(t, owner).map((fact, index) => {
              const Icon = FACT_ICONS[index] ?? Laptop
              return (
                <ListRow
                  key={fact}
                  title={fact}
                  wrapTitle
                  leading={<Icon size={17} strokeWidth={2} color={colors.textSecondary} />}
                />
              )
            })}
          </ListGroup>
          {services.length > 0 ? (
            <View style={styles.uses}>
              <Text style={styles.usesLabel}>{t('bots.share.invite.uses', 'Uses')}</Text>
              {services.map((service) => (
                <View key={service} style={styles.chip}>
                  {service === 'google' ? (
                    <MobileGoogleMark size={12} />
                  ) : (
                    <MobileConnectorSourceIcon source={service} size={12} />
                  )}
                  <Text style={styles.chipText}>{SERVICE_NAMES[service]}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </>
      }
      cancelLabel={t('bots.share.decline', 'Decline')}
      onCancelPress={() => onAnswer(false)}
      confirmLabel={t('bots.share.accept', 'Accept')}
      onConfirm={() => onAnswer(true)}
      onCancel={onClose}
    />
  )
}

const SERVICE_NAMES: Record<AgentCardService, string> = {
  github: 'GitHub',
  slack: 'Slack',
  linear: 'Linear',
  google: 'Google'
}

function RequestRow({ pairedHostId, request, divider }: HostRequest & { divider: boolean }) {
  const t = useMobileTranslation()
  const [open, setOpen] = useState(false)
  const [answering, setAnswering] = useState(false)
  const answer = async (accept: boolean): Promise<void> => {
    setOpen(false)
    setAnswering(true)
    const done = await phoneSharedAgents().answerRequest(pairedHostId, request.shareId, accept)
    if (!done) {
      setAnswering(false)
      Alert.alert(t('bots.share.requestFailed', 'Couldn’t answer the request. Try again.'))
    }
  }
  const invitedLine = (owner: string): string =>
    t('bots.share.invite.invitedYou', '{{owner}} invited you', { owner })
  const invited = invitedLine(request.ownerName)
  // The name shortens first, so who invited and "invited you" both stay readable.
  const { before, after } = aroundOwner(invitedLine)
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${request.botName}, ${invited}`}
        disabled={answering}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        {divider ? <View style={styles.divider} /> : null}
        <View>
          <View style={styles.dimmed}>
            <MobileBotAvatar avatar={requestAvatar(request)} size={32} />
          </View>
          <View style={styles.badge}>
            <Mail size={10} strokeWidth={2.5} color={colors.textPrimary} />
          </View>
        </View>
        <View style={styles.main}>
          <View style={[styles.titleRow, styles.dimmed]}>
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
          <View style={styles.lineRow}>
            <View style={styles.person}>
              <UserRound size={10} color={colors.textMuted} />
            </View>
            <View style={styles.invited}>
              {before ? <Text style={[styles.line, styles.fixed]}>{before}</Text> : null}
              <Text numberOfLines={1} style={styles.line}>
                {request.ownerName}
              </Text>
              {after ? <Text style={[styles.line, styles.fixed]}>{after}</Text> : null}
            </View>
          </View>
        </View>
        {answering ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <Text style={styles.view}>{t('bots.share.invite.view', 'View invite')}</Text>
        )}
      </Pressable>
      <BottomDrawer visible={open} onClose={() => setOpen(false)}>
        <InviteSheetContent
          request={request}
          onAnswer={(accept) => void answer(accept)}
          onClose={() => setOpen(false)}
        />
      </BottomDrawer>
    </>
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
    alignItems: 'center',
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
  dimmed: { opacity: 0.6 },
  badge: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgBase
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { flexShrink: 1, fontSize: 15, color: colors.textSecondary, fontWeight: '500' },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  person: {
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  line: { flexShrink: 1, fontSize: 13, color: colors.textMuted },
  invited: { flexDirection: 'row', flexShrink: 1, minWidth: 0 },
  fixed: { flexShrink: 0 },
  view: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  purpose: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.md
  },
  uses: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingHorizontal: spacing.xs
  },
  usesLabel: { fontSize: typography.metaSize, color: colors.textSecondary },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 24,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  chipText: { fontSize: typography.metaSize, color: colors.textPrimary },
  pressed: { opacity: feedback.pressedOpacity }
}))
