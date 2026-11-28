import { useMemo, useState, type ReactNode } from 'react'
import { Keyboard, View } from 'react-native'
import type { BotChatTreeWorker } from '../../../../src/shared/bots/bot-chat-tree'
import {
  botItemLinkPreview,
  botItemLinksByImportance
} from '../../../../src/shared/bots/bot-item-link-order'
import type { BotItemLinkRow } from '../../../../src/shared/bots/bot-item-link-rows'
import type { BotItemLinkView } from '../../../../src/shared/bots/bot-items'
import { OptionPager, useOptionPager } from '../../components/bottom-drawer/BottomDrawer'
import { useBottomDrawerModalHostBackClaim } from '../../components/bottom-drawer/bottom-drawer-modal-host-scope'
import {
  ListGroup,
  ListRow,
  LIST_LEADING_INSET,
  SectionHeader
} from '../../components/list/ListGroup'
import { ActionSheetModal, type ActionSheetAction } from '../../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { openExternalLink } from '../../platform/external-links/external-link'
import { MobileBotItemLinkRow, type BotItemLinkPress } from './MobileBotItemLinkRow'
import { MobileBotItemLinksPage } from './MobileBotItemLinksPage'

type LinkTargets = {
  bot: { id: string; name: string }
  onOpenWorker: (worker: BotChatTreeWorker) => void
  /** Opens a file in the bot's folder; refuses one outside it. */
  onOpenFile: (path: string) => void
}

/** The item page's Links section, and `around` to wrap the page so "All N" can push the full list over it. */
export function useMobileBotItemLinks({
  links,
  ...targets
}: LinkTargets & { links: readonly BotItemLinkView[] | undefined }): {
  section: ReactNode
  around: (page: ReactNode) => ReactNode
} {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const pager = useOptionPager<'links'>()
  const open = () => {
    Keyboard.dismiss()
    pager.open('links')
  }
  const close = () => {
    Keyboard.dismiss()
    pager.close()
  }
  const back = pager.page
    ? () => {
        close()
        return true
      }
    : null
  useBottomDrawerModalHostBackClaim(back)
  useBackClaim(back)
  const [pressed, setPressed] = useState<BotItemLinkPress | null>(null)
  const rows = useMemo(() => botItemLinksByImportance(links ?? []), [links])
  const section =
    rows.length > 0 ? (
      <>
        <SectionHeader title={`${t('bots.items.view.links', 'Links')} ${rows.length}`} />
        <LinksPreview rows={rows} {...targets} onLongPress={setPressed} onAll={open} />
      </>
    ) : null
  const actions: ActionSheetAction[] = pressed
    ? [
        ...(pressed.url
          ? [
              {
                id: 'open',
                label: t('bots.items.link.openInBrowser', 'Open in browser'),
                onPress: () => openExternalLink(pressed.url ?? '')
              }
            ]
          : []),
        {
          id: 'copy',
          label: pressed.url
            ? t('bots.items.link.copyLink', 'Copy link')
            : t('bots.items.link.copyPath', 'Copy path'),
          onPress: () => void clipboard.writeText(pressed.copy)
        }
      ]
    : []
  const around = (page: ReactNode): ReactNode => (
    <>
      <OptionPager
        pager={pager}
        main={page}
        page={
          pager.page === 'links' ? (
            <MobileBotItemLinksPage
              rows={rows}
              {...targets}
              onLongPress={setPressed}
              onBack={close}
            />
          ) : null
        }
        fill
      />
      <ActionSheetModal
        visible={pressed !== null}
        title={pressed?.title}
        {...(pressed?.message ? { message: pressed.message } : {})}
        actions={actions}
        onClose={() => setPressed(null)}
      />
    </>
  )
  return { section, around }
}

function LinksPreview({
  rows,
  onAll,
  ...row
}: LinkTargets & {
  rows: readonly BotItemLinkRow[]
  onLongPress: (press: BotItemLinkPress) => void
  onAll: () => void
}) {
  const t = useMobileTranslation()
  const preview = botItemLinkPreview(rows)
  return (
    <ListGroup separatorInset={LIST_LEADING_INSET}>
      {preview.map((entry) => (
        <MobileBotItemLinkRow key={entry.key} entry={entry} {...row} />
      ))}
      {rows.length > preview.length ? (
        <ListRow
          title={t('pullRequest.screens.allCount', 'All {{count}}', { count: rows.length })}
          leading={<View />}
          accent
          navigates
          onPress={onAll}
        />
      ) : null}
    </ListGroup>
  )
}
