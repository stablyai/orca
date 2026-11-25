// Share bot as a page of the bot's Settings: the bot as the link shows it, then either its contents and
// Publish link, or its live link and what Update link would send. The desktop's BotShareFlow.
import { useMemo, useState, type ReactNode } from 'react'
import { Text, View } from 'react-native'
import { CloudOff, Link2, ShieldAlert } from 'lucide-react-native'
import { BOT_SHARE_ERRORS } from '../../../../src/shared/bots/bot-share-errors'
import { botShareFlagSpot } from '../../../../src/shared/bots/bot-share-flag-spots'
import { ListRow, SectionHeader } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { useBottomDrawerModalHostBackClaim } from '../../components/bottom-drawer/bottom-drawer-modal-host-scope'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { MobileBotAvatarSource } from '../host-bot-row-facts'
import { MobileBotAvatar } from '../MobileBotAvatar'
import { MobileBotTextButton } from '../MobileBotTextButton'
import {
  botShareDate,
  botShareErrorMessage,
  botShareFlagLabel,
  botShareUrlText
} from './bot-share-copy'
import {
  botShareErrorCode,
  publishPhoneBotShare,
  type PhoneShareCandidate
} from './bot-share-operations'
import { useHostOrcaSignIn } from './use-host-orca-sign-in'
import { usePhoneBotShareCandidate } from './use-phone-bot-share-candidate'
import type { PhoneShareLinkState } from './use-phone-bot-share-link'
import { ShareFoot, ShareOverview, type Phase } from './MobileBotShareOverview'
import { SharePartFiles } from './MobileBotShareFiles'
import { ShareListPage } from './MobileBotShareParts'
import {
  shareFlagPage,
  shareListTitle,
  type ShareContext,
  type SharePage
} from './mobile-share-pages'

export type ShareFlowProps = {
  client: RpcClient | null
  bot: { id: string; name: string }
  avatar: MobileBotAvatarSource
  linkState: PhoneShareLinkState
  hostName: string
  online: boolean
  banner: ReactNode
  showToast: (message: string, durationMs?: number) => void
  onBack: { label: string; onPress: () => void }
}

export function MobileBotShareFlow(props: ShareFlowProps) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { client, bot, linkState } = props
  const { read, setLink, reread } = linkState
  const link = read.kind === 'read' ? read.link : null
  const state = usePhoneBotShareCandidate(
    client,
    bot.id,
    read.kind === 'read' ? (link ? 'last' : 'defaults') : 'local'
  )
  const { candidate } = state
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [error, setError] = useState<{ message: string; moved: boolean } | null>(null)
  const [nav, setNav] = useState<SharePage[]>([])
  const clipboard = useClipboardWriter()
  const signIn = useHostOrcaSignIn(client, reread)
  const popPage = nav.length > 0 ? () => setNav((current) => current.slice(0, -1)) : null
  useBottomDrawerModalHostBackClaim(popPage)
  useBackClaim(
    popPage
      ? () => {
          popPage()
          return true
        }
      : null
  )

  const spots = useMemo(
    () => (candidate ? candidate.flags.map((flag) => botShareFlagSpot(flag, candidate)) : []),
    [candidate]
  )
  const secret = spots.find((spot) => spot.flag.kind === 'secret') ?? null
  const open = (page: SharePage) => setNav((current) => [...current, page])
  const upToDate =
    link && candidate && state.committed && link.digest !== null
      ? candidate.botDigest === link.digest && state.note.trim() === (candidate.bot.setupNote ?? '')
      : null

  const copy = async (url: string) => {
    try {
      await clipboard.writeText(url)
      props.showToast(t('bots.share.linkCopied', 'Link copied'))
    } catch {
      props.showToast(t('bots.share.copyFailed', 'Couldn’t copy the link'))
    }
  }

  const publish = async (retried = false, shown: PhoneShareCandidate | null = candidate) => {
    if (!shown || !client) {
      return
    }
    setPhase({ kind: 'busy' })
    setError(null)
    let published: Awaited<ReturnType<typeof publishPhoneBotShare>>
    try {
      published = await publishPhoneBotShare(client, {
        botId: bot.id,
        candidateId: shown.candidateId,
        setupNote: state.note,
        ...(link ? { link: { shareId: link.shareId, expectedVersionId: link.versionId } } : {})
      })
    } catch (cause) {
      const code = botShareErrorCode(cause)
      // An expired preview, or a package made meanwhile: build again from the same picks, once.
      if (
        !retried &&
        (code === BOT_SHARE_ERRORS.expired || code === BOT_SHARE_ERRORS.prepareAgain)
      ) {
        const rebuilt = await state.select({}, { setupNote: shown.bot.setupNote ?? '' })
        if (rebuilt) {
          if (rebuilt.botDigest !== shown.botDigest) {
            setPhase({ kind: 'idle' })
            setError({
              message: t(
                'bots.share.previewChanged',
                'The preview changed. Review it before publishing.'
              ),
              moved: false
            })
            return
          }
          return publish(true, rebuilt)
        }
      }
      if (code === BOT_SHARE_ERRORS.signIn || code === BOT_SHARE_ERRORS.reconnect) {
        setPhase({ kind: 'idle' })
        reread()
        return
      }
      const moved = code === BOT_SHARE_ERRORS.moved
      setPhase({ kind: 'idle' })
      setError({
        message: moved
          ? t('bots.share.movedHere', 'This link was updated somewhere else.')
          : botShareErrorMessage(cause),
        moved
      })
      return
    }
    const first = !link
    setLink({
      shareId: published.share.id,
      url: published.share.url,
      versionId: published.share.pinnedVersionId,
      updatedAt: new Date().toISOString(),
      digest: published.version.packageDigest
    })
    setNav([])
    // The first link goes on the clipboard: sending it is the only thing left to do.
    if (first) {
      await copy(published.share.url)
    }
    setPhase({ kind: 'done', updated: !first })
  }

  const ctx: ShareContext | null = candidate
    ? {
        client,
        botId: bot.id,
        candidate,
        selection: state.selection,
        select: (change) => void state.select(change),
        spots,
        open,
        note: state.note,
        setNote: state.setNote
      }
    : null

  const page = nav.at(-1)
  const pageTitle = (entry: SharePage) =>
    entry.kind === 'part' ? entry.title : shareListTitle(entry.list, t)
  if (page && ctx) {
    const backLabel =
      nav.length > 1 ? pageTitle(nav.at(-2)!) : t('bots.share.shareBot', 'Share bot…')
    return (
      <>
        <SheetHeader
          title={pageTitle(page)}
          subtitle={
            page.kind === 'part'
              ? page.detail
              : page.list === 'memory'
                ? t('bots.share.countOf', '{{picked}} of {{all}}', {
                    picked: ctx.selection.memory?.length ?? 0,
                    all: ctx.candidate.available.memory.length
                  })
                : undefined
          }
          onBack={{ label: backLabel, onPress: () => setNav((current) => current.slice(0, -1)) }}
        />
        {page.kind === 'part' ? (
          <SharePartFiles
            client={client}
            botId={bot.id}
            candidateId={ctx.candidate.candidateId}
            part={page.part}
            showNames={page.showNames === true}
          />
        ) : (
          <ShareListPage list={page.list} ctx={ctx} />
        )}
      </>
    )
  }

  const done = phase.kind === 'done'
  return (
    <>
      <SheetHeader title={t('bots.share.title', 'Share bot')} onBack={props.onBack} />
      {props.banner}
      <View style={styles.hero}>
        <MobileBotAvatar avatar={props.avatar} size={link && !done ? 48 : 64} />
        <Text style={styles.name} numberOfLines={2}>
          {bot.name}
        </Text>
        {candidate ? (
          <Text style={styles.purpose} numberOfLines={2}>
            {candidate.bot.purpose || t('bots.share.noPurpose', 'No purpose yet')}
          </Text>
        ) : null}
      </View>
      {read.kind === 'offline' ? (
        <SettingsSection>
          <ListRow
            leading={<CloudOff size={18} color={colors.textSecondary} />}
            title={
              read.error ?? t('bots.share.linkStatusUnavailable', 'Couldn’t check the share link')
            }
            wrapTitle
            accessory={
              <MobileBotTextButton label={t('settings.bots.retry', 'Retry')} onPress={reread} />
            }
          />
        </SettingsSection>
      ) : link ? (
        <SettingsSection>
          <ListRow
            leading={<Link2 size={18} color={colors.textSecondary} />}
            title={botShareUrlText(link.url)}
            subtitle={
              done
                ? phase.updated
                  ? t('bots.share.updatedJustNow', 'Updated just now')
                  : `${t('bots.share.publishedJustNow', 'Published just now')} · ${t(
                      'bots.share.description',
                      'Anyone with the link can make a copy.'
                    )}`
                : [
                    t('bots.share.updatedAt', 'Updated {{date}}', {
                      date: botShareDate(link.updatedAt, true)
                    }),
                    upToDate === null
                      ? null
                      : upToDate
                        ? t('bots.share.upToDate', 'Up to date')
                        : t('bots.share.changedSince', 'Bot changed since')
                  ]
                    .filter(Boolean)
                    .join(' · ')
            }
            accessory={
              <MobileBotTextButton
                label={t('bots.share.copy', 'Copy')}
                accessibilityLabel={t('bots.share.copyLink', 'Copy link')}
                onPress={() => void copy(link.url)}
              />
            }
          />
        </SettingsSection>
      ) : null}
      {done ? null : (
        <>
          {secret ? (
            <SettingsSection>
              <ListRow
                leading={<ShieldAlert size={18} color={colors.statusRed} />}
                title={t('bots.share.secretFoundTitle', 'Secret found')}
                subtitle={t('bots.share.secretWhere', '{{flag}} in {{where}}, line {{line}}', {
                  flag: botShareFlagLabel(secret.flag.kind),
                  where: secret.where,
                  line: secret.flag.line ?? 1
                })}
                accessory={
                  shareFlagPage(secret, t) ? (
                    <MobileBotTextButton
                      label={t('bots.share.view', 'View')}
                      onPress={() => {
                        const target = shareFlagPage(secret, t)
                        if (target) {
                          open(target)
                        }
                      }}
                    />
                  ) : undefined
                }
              />
            </SettingsSection>
          ) : null}
          {link ? <SectionHeader title={t('bots.share.nextUpdate', 'Next update')} /> : null}
          {state.error ? (
            <SettingsSection>
              <ListRow
                title={state.error}
                wrapTitle
                accessory={
                  <MobileBotTextButton
                    label={t('settings.bots.retry', 'Retry')}
                    onPress={state.rebuild}
                  />
                }
              />
            </SettingsSection>
          ) : null}
          <ShareOverview ctx={ctx} online={props.online} first={Boolean(link)} />
          {link ? (
            <SettingsNote>
              {t(
                'bots.share.sameLink',
                'Goes to the same link. Copies already made stay as they are.'
              )}
            </SettingsNote>
          ) : null}
        </>
      )}
      <ShareFoot
        read={read}
        link={link}
        phase={phase}
        error={error}
        secret={secret !== null}
        upToDate={upToDate}
        ready={
          candidate !== null &&
          !candidate.blocked &&
          state.committed &&
          props.online &&
          read.kind === 'read'
        }
        building={state.building}
        signIn={signIn}
        hostName={props.hostName}
        onPublish={() => void publish()}
        onReload={() => {
          setError(null)
          reread()
        }}
        onDone={props.onBack.onPress}
      />
    </>
  )
}

const styles = themedStyleSheet(() => ({
  hero: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm
  },
  name: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.textPrimary,
    marginTop: spacing.sm,
    textAlign: 'center'
  },
  purpose: { fontSize: 14, lineHeight: 19, color: colors.textSecondary, textAlign: 'center' }
}))
