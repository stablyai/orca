// Shared links: every live bot link the computer's Orca account published, with each link's actions.
// The desktop's Settings › Shared links (BotSharedLinksList).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { View, type HostInstance } from 'react-native'
import { Copy, Ellipsis, Link2Off, RefreshCw } from '../../components/icons/app-icons'
import { botPackageName, type BotOwnedShare } from '../../../../src/shared/bots/bot-share-status'
import { LoadingSpinner } from '../../components/feedback/LoadingSpinner'
import { ListRow } from '../../components/list/ListGroup'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../../components/nav-bar/PullDownMenu'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { colors } from '../../theme/mobile-theme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { mobileBotAvatarSource } from '../host-bot-row-facts'
import type { ListedBot } from '../host-bots-operations'
import { MobileBotAvatar } from '../MobileBotAvatar'
import { botShareDate, botShareErrorMessage } from './bot-share-copy'
import { listPhoneBotShares, stopPhoneBotShare } from './bot-share-operations'

/** A link's row opens its bot's Share bot; Update link opens it too, as on the desktop. */
export type SharedLinkOpen = { bot: ListedBot; share: BotOwnedShare }

function SharedLinkRow(props: {
  share: BotOwnedShare
  bot: ListedBot | null
  disabled: boolean
  onCopy: () => void
  onOpen: () => void
  onStop: () => void
}) {
  const t = useMobileTranslation()
  const anchor = useRef<HostInstance>(null)
  const [menu, setMenu] = useState(false)
  const { share, bot } = props
  const name = bot?.name ?? share.displayName ?? share.name
  return (
    <>
      <ListRow
        leading={
          bot ? <MobileBotAvatar avatar={mobileBotAvatarSource(bot)} size={28} /> : undefined
        }
        title={name}
        subtitle={share.url.replace(/^https:\/\//, '')}
        subtitleMono
        subtitleLines={1}
        value={botShareDate(share.createdAt)}
        disabled={props.disabled}
        onPress={bot ? props.onOpen : undefined}
        accessory={
          <NavBarButton
            ref={anchor}
            icon={Ellipsis}
            accessibilityLabel={t('bots.share.moreActions', 'More actions for {{name}}', { name })}
            onPress={() => setMenu(true)}
          />
        }
      />
      <PullDownMenu
        visible={menu}
        anchorRef={anchor}
        onClose={() => setMenu(false)}
        groups={[
          [
            {
              id: 'copy',
              label: t('bots.share.copyLink', 'Copy link'),
              icon: Copy,
              onPress: props.onCopy
            },
            // Update link rebuilds from the bot, so it needs the bot here; stopping needs only the link.
            ...(bot
              ? [
                  {
                    id: 'update',
                    label: t('bots.share.updateLink', 'Update link'),
                    icon: RefreshCw,
                    closeBeforePress: true,
                    onPress: props.onOpen
                  }
                ]
              : []),
            {
              id: 'stop',
              label: t('bots.share.stopSharing', 'Stop sharing'),
              icon: Link2Off,
              destructive: true,
              closeBeforePress: true,
              onPress: props.onStop
            }
          ]
        ]}
      />
    </>
  )
}

/** The computer's bot links, from its Orca account; `bots` are the bots on that computer. */
export function MobileSharedLinks(props: {
  client: RpcClient | null
  bots: readonly ListedBot[]
  online: boolean
  showToast: (message: string, durationMs?: number) => void
  onOpen: (open: SharedLinkOpen) => void
  /** Above the list: the page's header. */
  header: ReactNode
}) {
  const t = useMobileTranslation()
  const { client } = props
  const clipboard = useClipboardWriter()
  const [shares, setShares] = useState<BotOwnedShare[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stopping, setStopping] = useState<{ share: BotOwnedShare; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    if (!client) {
      return
    }
    setError(null)
    listPhoneBotShares(client).then(setShares, (cause: unknown) =>
      setError(botShareErrorMessage(cause))
    )
  }, [client])
  useEffect(load, [load])

  if (stopping) {
    return (
      <ConfirmContent
        title={t('bots.share.stopTitle', 'Stop sharing {{name}}?', { name: stopping.name })}
        message={t('bots.share.stopDescription', 'The link stops working.')}
        confirmLabel={t('bots.share.stopSharing', 'Stop sharing')}
        destructive
        onCancel={() => setStopping(null)}
        onConfirm={() => {
          const { share, name } = stopping
          setStopping(null)
          if (!client) {
            return
          }
          const bot = props.bots.find((entry) => botPackageName(entry.id) === share.name)
          setBusy(true)
          stopPhoneBotShare(client, share.id, bot?.id)
            .then(
              () => {
                props.showToast(t('bots.share.stopped', 'Stopped sharing {{name}}', { name }))
                load()
              },
              (cause: unknown) => props.showToast(botShareErrorMessage(cause), 2400)
            )
            .finally(() => setBusy(false))
        }}
      />
    )
  }

  const body = error ? (
    <SettingsNote error>{error}</SettingsNote>
  ) : !shares ? (
    <SettingsSection first>
      <ListRow
        leading={<LoadingSpinner size={18} color={colors.textMuted} />}
        title={t('bots.share.loadingLinks', 'Loading shared links…')}
      />
    </SettingsSection>
  ) : shares.length === 0 ? (
    <SettingsNote>
      {t('bots.share.noLinks', 'No bot links. Share a bot from its settings.')}
    </SettingsNote>
  ) : (
    <SettingsSection title={t('settings.sharedLinks.bots', 'Bots')}>
      {/* Canonical links first; older builds' links stay listed, so nothing is stopped silently. */}
      {[...shares]
        .sort((a, b) => Number(b.canonical) - Number(a.canonical))
        .map((share) => {
          const bot = props.bots.find((entry) => botPackageName(entry.id) === share.name) ?? null
          const name = bot?.name ?? share.displayName ?? share.name
          return (
            <SharedLinkRow
              key={share.id}
              share={share}
              bot={bot}
              disabled={busy || !props.online}
              onCopy={() =>
                void clipboard.writeText(share.url).then(
                  () => props.showToast(t('bots.share.linkCopied', 'Link copied')),
                  () => props.showToast(t('bots.share.copyFailed', 'Couldn’t copy the link'))
                )
              }
              onOpen={() => (bot ? props.onOpen({ bot, share }) : undefined)}
              onStop={() => setStopping({ share, name })}
            />
          )
        })}
    </SettingsSection>
  )
  return (
    <>
      {props.header}
      <View>{body}</View>
      {shares && shares.length > 0 ? (
        <SettingsNote>
          {t('settings.sharedLinks.description', 'Links you’ve published.')}
        </SettingsNote>
      ) : null}
    </>
  )
}
