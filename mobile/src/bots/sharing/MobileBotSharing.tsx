// The bot's Settings › Sharing on the phone: the row, and the page it opens, from which Share bot,
// Stop sharing and Manage links go. The desktop's BotSharingGroup and BotSharingPage.
import { useState, type ReactNode } from 'react'
import { Link, Link2, Share2 } from 'lucide-react-native'
import type { BotOwnedShare } from '../../../../src/shared/bots/bot-share-status'
import { LoadingSpinner } from '../../components/feedback/LoadingSpinner'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { DrillRow } from '../../host-screen/workspace-options/workspace-option-rows'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { colors } from '../../theme/mobile-theme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { useHostBotsListing } from '../host-bot-store'
import { mobileBotAvatarSource, type MobileBotAvatarSource } from '../host-bot-row-facts'
import type { ListedBot } from '../host-bots-operations'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { botShareDate, botShareErrorMessage, botShareUrlText } from './bot-share-copy'
import { stopPhoneBotShare } from './bot-share-operations'
import { MobileBotShareFlow } from './MobileBotShareFlow'
import { MobileSharedLinks } from './MobileSharedLinks'
import { usePhoneBotShareLink, type PhoneShareLinkRead } from './use-phone-bot-share-link'

type SettingsContext = {
  client: RpcClient | null
  routeBot: { bot: { id: string; name: string }; avatar: MobileBotAvatarSource }
  showToast: (message: string, durationMs?: number) => void
  online: boolean
  hostName: string
}

type Step =
  | { kind: 'sharing' }
  | { kind: 'share' }
  | { kind: 'stop' }
  | { kind: 'links' }
  | { kind: 'link'; bot: ListedBot; share: BotOwnedShare }

/** The Settings row and, while open, the page that replaces Settings. */
export function useMobileBotSharingSettings(
  settings: SettingsContext,
  banner: ReactNode
): { row: ReactNode; page: ReactNode } {
  const t = useMobileTranslation()
  const { bot, avatar } = settings.routeBot
  const linkState = usePhoneBotShareLink(settings.client, bot.id)
  const [steps, setSteps] = useState<Step[]>([])
  const push = (step: Step) => setSteps((current) => [...current, step])
  const back = () => {
    // Shared links may have stopped or moved this bot's link: Sharing reads it again.
    if (steps.at(-1)?.kind === 'links') {
      linkState.reread()
    }
    setSteps((current) => current.slice(0, -1))
  }
  useBackClaim(
    steps.length > 0
      ? () => {
          back()
          return true
        }
      : null
  )
  const { read } = linkState
  const link = read.kind === 'read' ? read.link : undefined
  const row = (
    <SettingsSection>
      <DrillRow
        label={t('bots.settingsView.sharing', 'Sharing')}
        value={
          link === null
            ? t('bots.settingsPage.off', 'Off')
            : link
              ? t('bots.settingsView.sharingOn', 'On')
              : read.kind === 'offline'
                ? t('bots.settings.readFailed', 'Couldn’t load')
                : ''
        }
        onPress={() => {
          if (read.kind === 'offline') {
            linkState.reread()
          }
          push({ kind: 'sharing' })
        }}
      />
    </SettingsSection>
  )
  const step = steps.at(-1)
  if (!step) {
    return { row, page: null }
  }
  const backTo = (label: string) => ({ label, onPress: back })
  switch (step.kind) {
    case 'sharing':
      return {
        row: null,
        page: (
          <SharingPage
            botName={bot.name}
            read={read}
            banner={banner}
            online={settings.online}
            showToast={settings.showToast}
            onBack={backTo(t('bots.lookAround.back', 'Back to Settings'))}
            onRetry={linkState.reread}
            onShare={() => push({ kind: 'share' })}
            onStop={() => push({ kind: 'stop' })}
            onManageLinks={() => push({ kind: 'links' })}
          />
        )
      }
    case 'share':
      return {
        row: null,
        page: (
          <MobileBotShareFlow
            client={settings.client}
            bot={bot}
            avatar={avatar}
            linkState={linkState}
            hostName={settings.hostName}
            online={settings.online}
            banner={banner}
            showToast={settings.showToast}
            onBack={backTo(t('bots.share.backToSharing', 'Back to Sharing'))}
          />
        )
      }
    case 'stop':
      return {
        row: null,
        page: (
          <StopConfirm
            client={settings.client}
            botId={bot.id}
            name={bot.name}
            shareId={link?.shareId ?? null}
            showToast={settings.showToast}
            onDone={(stopped) => {
              if (stopped) {
                linkState.setLink(null)
              }
              back()
            }}
          />
        )
      }
    case 'links':
      return {
        row: null,
        page: (
          <SiblingSharedLinks
            botId={bot.id}
            client={settings.client}
            online={settings.online}
            showToast={settings.showToast}
            header={
              <>
                <SheetHeader
                  title={t('settings.sharedLinks.title', 'Shared links')}
                  subtitle={settings.hostName}
                  onBack={backTo(t('bots.share.backToSharing', 'Back to Sharing'))}
                />
                {banner}
              </>
            }
            onOpen={(open) => push({ kind: 'link', ...open })}
          />
        )
      }
    case 'link':
      return {
        row: null,
        page: (
          <MobileLinkShareFlow
            {...settings}
            bot={step.bot}
            shareId={step.share.id}
            banner={banner}
            onBack={backTo(t('bots.share.backToLinks', 'Back to Shared links'))}
          />
        )
      }
  }
}

/** Shared links for the computer this bot runs on, matched to the bots listed there. */
function SiblingSharedLinks(
  props: Omit<Parameters<typeof MobileSharedLinks>[0], 'bots'> & { botId: string }
) {
  const bots = useHostBotsListing(props.botId)
  return <MobileSharedLinks {...props} bots={bots} />
}

/** Share bot for a link opened from Shared links: that link's bot, read for that link. */
export function MobileLinkShareFlow(
  props: Omit<SettingsContext, 'routeBot'> & {
    bot: ListedBot
    shareId: string
    banner: ReactNode
    onBack: { label: string; onPress: () => void }
  }
) {
  const linkState = usePhoneBotShareLink(props.client, props.bot.id, props.shareId)
  return (
    <MobileBotShareFlow
      {...props}
      avatar={mobileBotAvatarSource(props.bot)}
      linkState={linkState}
    />
  )
}

function SharingPage(props: {
  botName: string
  read: PhoneShareLinkRead
  banner: ReactNode
  online: boolean
  showToast: (message: string, durationMs?: number) => void
  onBack: { label: string; onPress: () => void }
  onRetry: () => void
  onShare: () => void
  onStop: () => void
  onManageLinks: () => void
}) {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const { read } = props
  const link = read.kind === 'read' ? read.link : null
  const header = (
    <>
      <SheetHeader title={t('bots.settingsView.sharing', 'Sharing')} onBack={props.onBack} />
      {props.banner}
    </>
  )
  const manageLinks = (
    <SettingsSection>
      <ListRow
        leading={<Link size={18} color={colors.textSecondary} />}
        title={t('bots.share.manageLinks', 'Manage links')}
        navigates
        disabled={!props.online}
        onPress={props.onManageLinks}
      />
    </SettingsSection>
  )
  if (!link) {
    return (
      <>
        {header}
        <SettingsSection first>
          <ListRow
            leading={<Share2 size={18} color={colors.textSecondary} />}
            title={
              read.kind === 'read'
                ? t('bots.share.notShared', 'Not shared')
                : t('bots.settingsView.sharing', 'Sharing')
            }
            subtitle={t('bots.share.description', 'Anyone with the link can make a copy.')}
            accessory={
              <MobileBotTextButton
                label={t('bots.share.shareBot', 'Share bot…')}
                disabled={!props.online || read.kind === 'loading'}
                onPress={props.onShare}
              />
            }
          />
          {read.kind === 'loading' ? (
            <ListRow
              leading={<LoadingSpinner size={18} color={colors.textMuted} />}
              title={t('bots.share.loadingLinks', 'Loading shared links…')}
            />
          ) : read.kind === 'offline' ? (
            <ListRow
              title={
                read.error ?? t('bots.share.linkStatusUnavailable', 'Couldn’t check the share link')
              }
              wrapTitle
              accessory={
                <MobileBotTextButton
                  label={t('settings.bots.retry', 'Retry')}
                  onPress={props.onRetry}
                />
              }
            />
          ) : null}
        </SettingsSection>
        {read.kind === 'read' ? manageLinks : null}
      </>
    )
  }
  const copy = () =>
    void clipboard.writeText(link.url).then(
      () => props.showToast(t('bots.share.linkCopied', 'Link copied')),
      () => props.showToast(t('bots.share.copyFailed', 'Couldn’t copy the link'))
    )
  return (
    <>
      {header}
      <SettingsSection
        title={t('bots.share.isShared', '{{name}} is shared', { name: props.botName })}
      >
        <ListRow
          leading={<Link2 size={18} color={colors.textSecondary} />}
          title={botShareUrlText(link.url)}
          subtitle={t('bots.share.updatedAt', 'Updated {{date}}', {
            date: botShareDate(link.updatedAt, true)
          })}
          accessory={
            <MobileBotTextButton
              label={t('bots.share.copy', 'Copy')}
              accessibilityLabel={t('bots.share.copyLink', 'Copy link')}
              onPress={copy}
            />
          }
        />
        <ListRow
          title={t('bots.share.updateLink', 'Update link')}
          subtitle={t(
            'bots.share.sameLink',
            'Goes to the same link. Copies already made stay as they are.'
          )}
          navigates
          disabled={!props.online}
          onPress={props.onShare}
        />
      </SettingsSection>
      {manageLinks}
      <SettingsSection>
        <ListRow
          title={t('bots.share.stopSharing', 'Stop sharing')}
          destructive
          disabled={!props.online}
          accessibilityRole="button"
          onPress={props.onStop}
        />
      </SettingsSection>
    </>
  )
}

function StopConfirm(props: {
  client: RpcClient | null
  botId: string
  name: string
  shareId: string | null
  showToast: (message: string, durationMs?: number) => void
  onDone: (stopped: boolean) => void
}) {
  const t = useMobileTranslation()
  const [stopping, setStopping] = useState(false)
  return (
    <ConfirmContent
      title={t('bots.share.stopTitle', 'Stop sharing {{name}}?', { name: props.name })}
      message={t('bots.share.stopDescription', 'The link stops working.')}
      confirmLabel={
        stopping
          ? t('bots.share.stopping', 'Stopping…')
          : t('bots.share.stopSharing', 'Stop sharing')
      }
      destructive
      onCancel={() => props.onDone(false)}
      onConfirm={() => {
        if (!props.client || !props.shareId || stopping) {
          return
        }
        setStopping(true)
        stopPhoneBotShare(props.client, props.shareId, props.botId).then(
          () => {
            props.showToast(
              t('bots.share.stopped', 'Stopped sharing {{name}}', { name: props.name })
            )
            props.onDone(true)
          },
          (cause: unknown) => {
            setStopping(false)
            props.showToast(botShareErrorMessage(cause), 2400)
          }
        )
      }}
    />
  )
}
