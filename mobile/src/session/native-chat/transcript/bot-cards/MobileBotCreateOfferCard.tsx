// The card a bot shows with `orca bot create --offer`: a new bot it proposes. Nothing is made until
// the owner presses Create bot (or creates from Edit); the card then reads Created, from the bots there are.
import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { Check, ChevronDown, ChevronUp } from 'lucide-react-native'
import { isBotMascotId } from '../../../../../../src/shared/bot-avatar'
import { isBotAgent } from '../../../../../../src/shared/bot-types'
import {
  botCreateOfferOrigin,
  botCreateOfferTakenOver,
  botCreateOfferView,
  botProposalDetails
} from '../../../../../../src/shared/bots/bot-create-offer-view'
import { botTemplateText } from '../../../../../../src/shared/bots/bot-template-text'
import {
  botCreateOfferState,
  proposalCreateParams,
  type BotCreateOffer
} from '../../../../../../src/shared/bots/bot-proposal'
import { BOTS_TEMPLATES_RUNTIME_CAPABILITY } from '../../../../../../src/shared/bot-runtime-capabilities'
import { botCreate } from '../../../../bots/bot-sheet-operations'
import { publishHostBot, useHostBotById, useHostBotsEntry } from '../../../../bots/host-bot-store'
import { mobileBotAvatarSource } from '../../../../bots/host-bot-row-facts'
import { workspaceLineageRead, type PhoneBot } from '../../../../bots/host-bots-operations'
import { MobileBotAvatar } from '../../../../bots/MobileBotAvatar'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { useRouteCapability } from '../../../../worktree/execution-hosts/use-route-capability'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { MobileNativeChatNoticePill } from '../notices/MobileNativeChatNoticePill'
import { useMobileNativeChatDisclosure } from '../viewport/mobile-native-chat-disclosure-store'
import { mobileBotCreateOfferSay } from './mobile-bot-card-copy'
import { useMobileBotCardHost } from './mobile-bot-card-host'
import { useMobileBotOfferAnswer } from './use-mobile-bot-offer-answer'
import {
  BOT_CARD_AVATAR_SIZE,
  MobileBotCardActions,
  MobileBotCardFrame,
  MobileBotCardMeta
} from './MobileBotCardFrame'

const NO_BOTS: readonly PhoneBot[] = []

/** How many of the asked-for workspaces are under the new bot now; read once it exists. */
function useTakenOver(
  client: RpcClient | null,
  createdFolderId: string | undefined,
  worktrees: BotCreateOffer['proposal']['worktrees']
): number {
  const [taken, setTaken] = useState(0)
  useEffect(() => {
    if (!client || !createdFolderId || !worktrees?.length) {
      return
    }
    let live = true
    void workspaceLineageRead
      .request(client)
      .then((response) => {
        const reply = workspaceLineageRead.interpret(response)
        if (live && reply.accepted) {
          const lineage = reply.value.workspaceLineage
          setTaken(
            botCreateOfferTakenOver(
              { folderWorkspaceId: createdFolderId },
              worktrees,
              (child) => lineage[child]?.parentWorkspaceKey
            )
          )
        }
      })
      // Unread, the card says it asked; it never claims a take-over it can't see.
      .catch(() => {})
    return () => {
      live = false
    }
  }, [client, createdFolderId, worktrees])
  return taken
}

export function MobileBotCreateOfferCard({
  offer,
  cardId,
  fallback,
  fontScale
}: {
  offer: BotCreateOffer
  cardId: string
  fallback: string
  fontScale: number
}): React.JSX.Element {
  const t = useMobileTranslation()
  const say = mobileBotCreateOfferSay(t)
  const host = useMobileBotCardHost()
  const client = host?.client ?? null
  const proposer = useHostBotById(offer.botId)
  const bots = useHostBotsEntry(host?.hostKey ?? null)?.bots ?? NO_BOTS
  const takesTemplates = useRouteCapability(BOTS_TEMPLATES_RUNTIME_CAPABILITY)
  const [open, setOpen] = useMobileNativeChatDisclosure(`bot-create-card:${cardId}`, false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const answer = useMobileBotOfferAnswer(offer.botId, cardId)
  const state = proposer ? botCreateOfferState(offer, proposer, bots) : null
  const created = state?.kind === 'created' ? bots.find((bot) => bot.id === state.botId) : undefined
  const taken = useTakenOver(client, created?.folderWorkspaceId, offer.proposal.worktrees)
  if (!proposer || !state || !host) {
    return (
      <Text style={[styles.fallback, scaledType(typography.bodySize, fontScale)]}>{fallback}</Text>
    )
  }
  const { proposal } = offer
  const view = botCreateOfferView(offer, state, created, taken, say, (text) =>
    botTemplateText(text, t)
  )
  const fromOffer = { botId: proposer.id, offerId: offer.offerId }
  // The new bot runs on its proposer's agent. One this build doesn't know isn't made directly; Edit picks one.
  const agent = isBotAgent(proposer.agent) ? proposer.agent : null
  const edit = () =>
    host.editOffer({
      proposal,
      ...(agent ? { agent } : {}),
      fromOffer,
      origin: botCreateOfferOrigin(proposal, proposer.name, say, (text) =>
        botTemplateText(text, t)
      ),
      templatePackages: takesTemplates
    })
  const fail = (caught: unknown) =>
    setError(caught instanceof Error ? caught.message : String(caught))

  const create = () => {
    if (!client || !agent) {
      return
    }
    setBusy(true)
    setError(null)
    answer.clearError()
    // The host makes one bot per card, however many devices press.
    void botCreate
      .request(
        client,
        proposalCreateParams(proposal, agent, { templatePackages: takesTemplates, fromOffer })
      )
      .then((response) => publishHostBot(host.hostKey, botCreate.interpret(response).bot))
      .catch(fail)
      .finally(() => setBusy(false))
  }

  const Chevron = open ? ChevronUp : ChevronDown
  const avatar = created ? (
    <MobileBotAvatar avatar={mobileBotAvatarSource(created)} size={BOT_CARD_AVATAR_SIZE} />
  ) : (
    <MobileBotAvatar
      avatar={
        proposal.mascot && isBotMascotId(proposal.mascot)
          ? { kind: 'mascot', id: proposal.mascot }
          : { kind: 'text', text: proposal.name.slice(0, 1).toUpperCase() }
      }
      size={BOT_CARD_AVATAR_SIZE}
    />
  )
  return (
    <MobileBotCardFrame
      avatar={avatar}
      heading={t('chat.botCards.offer.heading', 'New bot')}
      title={view.title}
      trailing={null}
      meta={
        <View style={styles.metaLine}>
          {view.line.kind === 'created' ? <Check size={12} color={colors.textMuted} /> : null}
          <MobileBotCardMeta fontScale={fontScale} lines={2}>
            {view.line.text}
          </MobileBotCardMeta>
          <Chevron size={14} color={colors.textMuted} style={styles.chevron} />
        </View>
      }
      fontScale={fontScale}
      onToggle={() => setOpen(!open)}
      expanded={open}
      testID={`bot-create-offer-card:${cardId}`}
    >
      {open ? (
        <View style={styles.details}>
          {botProposalDetails(proposal, (text) => botTemplateText(text, t)).map((detail) => (
            <Text
              key={detail.label}
              style={[styles.detail, scaledType(typography.metaSize, fontScale)]}
            >
              <Text style={styles.detailLabel}>{`${say(detail.label)}  `}</Text>
              {detail.text}
            </Text>
          ))}
        </View>
      ) : null}
      {view.open?.note ? (
        <MobileBotCardMeta fontScale={fontScale} lines={2}>
          {view.open.note}
        </MobileBotCardMeta>
      ) : null}
      {view.open && view.open.actions !== 'rename' && !agent ? (
        <MobileBotCardMeta fontScale={fontScale} lines={2}>
          {t(
            'chat.botCards.offer.unknownAgent',
            '{{bot}} runs an agent this app doesn’t know. Edit to pick one.',
            { bot: proposer.name }
          )}
        </MobileBotCardMeta>
      ) : null}
      {(error ?? answer.error) ? (
        <Text style={[styles.error, scaledType(typography.metaSize, fontScale)]}>
          {error ?? answer.error}
        </Text>
      ) : null}
      {view.open ? (
        <MobileBotCardActions>
          {answer.dismissed ? null : (
            <MobileNativeChatNoticePill
              label={t('chat.botCards.offer.notNow', 'Not now')}
              onPress={() => {
                setError(null)
                answer.dismiss()
              }}
            />
          )}
          {view.open.actions === 'rename' ? (
            <MobileNativeChatNoticePill label={say('rename')} onPress={edit} />
          ) : (
            <>
              <MobileNativeChatNoticePill label={say('edit')} onPress={edit} />
              <MobileNativeChatNoticePill
                label={say('create')}
                primary
                disabled={busy || !agent}
                onPress={create}
              />
            </>
          )}
        </MobileBotCardActions>
      ) : created ? (
        <MobileBotCardActions>
          <MobileNativeChatNoticePill
            label={say('open')}
            onPress={() => host.openBotHome(created)}
          />
        </MobileBotCardActions>
      ) : null}
    </MobileBotCardFrame>
  )
}

const styles = themedStyleSheet(() => ({
  fallback: { color: colors.textMuted },
  metaLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  chevron: { marginLeft: 'auto' },
  details: {
    gap: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  detail: { color: colors.textPrimary },
  detailLabel: { color: colors.textMuted },
  error: { color: colors.statusRed }
}))
