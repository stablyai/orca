// An item's Links on the phone, in the desktop's rows (shared botItemLinkRows): workers as the chats tree
// draws them, PRs and issues with live state, web links, files. What the desktop's hover tooltip says
// (state, checks, repo) is the row's accessibility label and its long-press sheet's message.
import { useState } from 'react'
import {
  Check,
  CircleCheck,
  CircleDot,
  FileText,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Hourglass,
  Link2,
  X
} from 'lucide-react-native'
import { Text, View } from 'react-native'
import {
  botItemLinkRows,
  botItemWorkerRow,
  type BotItemGitHubRow,
  type BotItemLinkRow
} from '../../../../src/shared/bots/bot-item-link-rows'
import type { BotChatTreeWorker } from '../../../../src/shared/bots/bot-chat-tree'
import type { BotItemLinkView } from '../../../../src/shared/bots/bot-items'
import { ListGroup, ListRow, LIST_LEADING_INSET } from '../../components/list/ListGroup'
import { ActionSheetModal, type ActionSheetAction } from '../../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { openExternalLink } from '../../platform/external-links/external-link'
import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { prStateColor } from '../../worktree/row-presentation/WorktreeMetaGlyphs'
import { MobileConnectorSourceIcon } from '../MobileConnectorSourceIcon'
import { MobileBotWorkerRow } from '../MobileBotChatTree'

const ICON = 15

function stateWord(row: BotItemGitHubRow, t: Translate): string {
  if (!row.state) {
    return t('bots.items.link.notRead', 'Not read yet')
  }
  switch (row.state) {
    case 'merged':
      return t('bots.items.link.merged', 'Merged')
    case 'draft':
      return t('bots.items.link.draft', 'Draft')
    case 'closed':
      return t('bots.items.link.closed', 'Closed')
    case 'open':
      return t('bots.items.link.open', 'Open')
  }
}

function checksWord(checks: string | null, t: Translate): string | null {
  return checks === 'success'
    ? t('bots.items.link.checksPassing', 'Checks passing')
    : checks === 'failure'
      ? t('bots.items.link.checksFailing', 'Checks failing')
      : checks === 'pending'
        ? t('bots.items.link.checksPending', 'Checks pending')
        : null
}

/** The desktop tooltip's line: "Open · Checks failing · stablyai/orca#41230". */
function gitHubStateLine(row: BotItemGitHubRow, t: Translate): string {
  return [stateWord(row, t), checksWord(row.checks, t), `${row.repo}#${row.number}`]
    .filter(Boolean)
    .join(' · ')
}

function gitHubTitle(row: BotItemGitHubRow, t: Translate): string {
  return (
    row.title ??
    (row.type === 'pr'
      ? t('bots.items.link.pr', 'PR #{{number}}', { number: row.number })
      : t('bots.items.link.issue', 'Issue #{{number}}', { number: row.number }))
  )
}

function GitHubIcon({ row }: { row: BotItemGitHubRow }) {
  if (!row.state) {
    return row.type === 'pr' ? (
      <GitPullRequest size={ICON} color={colors.textMuted} />
    ) : (
      <CircleDot size={ICON} color={colors.textMuted} />
    )
  }
  if (row.type === 'issue') {
    return row.state === 'closed' ? (
      <CircleCheck size={ICON} color={prStateColor('merged')} />
    ) : (
      <CircleDot size={ICON} color={prStateColor('open')} />
    )
  }
  const color = prStateColor(row.state)
  switch (row.state) {
    case 'merged':
      return <GitMerge size={ICON} color={color} />
    case 'closed':
      return <GitPullRequestClosed size={ICON} color={color} />
    case 'draft':
      return <GitPullRequestDraft size={ICON} color={color} />
    case 'open':
      return <GitPullRequest size={ICON} color={color} />
  }
}

/** CI only where it can still change: open and draft PRs with a finished result. */
function CiMark({ row }: { row: BotItemGitHubRow }) {
  if (
    row.type !== 'pr' ||
    (row.state !== 'open' && row.state !== 'draft') ||
    (row.checks !== 'success' && row.checks !== 'failure')
  ) {
    return null
  }
  return row.checks === 'success' ? (
    <Check size={14} color={colors.statusGreen} strokeWidth={2.5} />
  ) : (
    <X size={14} color={colors.statusRed} strokeWidth={2.5} />
  )
}

type LongPress = { title: string; message?: string; url?: string; copy: string }

export function MobileBotItemLinks({
  bot,
  links,
  onOpenWorker,
  onOpenFile
}: {
  bot: { id: string; name: string }
  links: readonly BotItemLinkView[]
  onOpenWorker: (worker: BotChatTreeWorker) => void
  /** Opens a file in the bot's folder; refuses one outside it. */
  onOpenFile: (path: string) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const [pressed, setPressed] = useState<LongPress | null>(null)
  const rows = botItemLinkRows(links)
  const row = (entry: BotItemLinkRow): React.JSX.Element => {
    switch (entry.kind) {
      case 'worker': {
        const worker = botItemWorkerRow(entry.link)
        return (
          <MobileBotWorkerRow
            key={entry.key}
            bot={bot}
            worker={worker}
            nested={false}
            onOpen={() => onOpenWorker(worker)}
          />
        )
      }
      case 'github': {
        const title = gitHubTitle(entry, t)
        const line = gitHubStateLine(entry, t)
        const where = `${entry.showRepo ? entry.repo : ''}#${entry.number}`
        return (
          <ListRow
            key={entry.key}
            title={title}
            leading={<GitHubIcon row={entry} />}
            accessory={
              <View style={styles.trail}>
                {entry.title ? <Text style={styles.label}>{where}</Text> : null}
                <CiMark row={entry} />
              </View>
            }
            accessibilityLabel={`${title}, ${line}`}
            onPress={() => openExternalLink(entry.url)}
            onLongPress={() =>
              setPressed({ title, message: line, url: entry.url, copy: entry.url })
            }
          />
        )
      }
      case 'server-pr':
        return (
          <ListRow
            key={entry.key}
            title={t('bots.items.link.serverPr', 'PR not shown for server work yet')}
            leading={<GitPullRequest size={ICON} color={colors.textMuted} />}
            disabled
          />
        )
      case 'web':
        return (
          <ListRow
            key={entry.key}
            title={entry.title}
            leading={
              entry.brand ? (
                <MobileConnectorSourceIcon source={entry.brand} />
              ) : (
                <Link2 size={ICON} color={colors.textMuted} />
              )
            }
            accessibilityLabel={`${entry.title}, ${entry.tip}`}
            onPress={() => openExternalLink(entry.url)}
            onLongPress={() =>
              setPressed({
                title: entry.title,
                message: entry.tip,
                url: entry.url,
                copy: entry.url
              })
            }
          />
        )
      case 'file':
        return (
          <ListRow
            key={entry.key}
            title={entry.name}
            leading={<FileText size={ICON} color={colors.textMuted} />}
            accessibilityLabel={`${entry.name}, ${entry.path}`}
            onPress={() => onOpenFile(entry.path)}
            onLongPress={() =>
              setPressed({ title: entry.name, message: entry.path, copy: entry.path })
            }
          />
        )
      case 'automation': {
        const title = entry.name ?? t('bots.items.link.automation', 'Automation')
        const line = entry.active
          ? t('bots.items.link.automationOn', 'Will wake the agent for this item')
          : t('bots.items.link.automationEnded', 'Ended')
        return (
          <ListRow
            key={entry.key}
            title={title}
            leading={<Hourglass size={ICON} color={colors.textMuted} />}
            accessibilityLabel={`${title}, ${line}`}
            disabled={!entry.active}
          />
        )
      }
    }
  }
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
  return (
    <>
      <ListGroup separatorInset={LIST_LEADING_INSET}>{rows.map(row)}</ListGroup>
      <ActionSheetModal
        visible={pressed !== null}
        title={pressed?.title}
        {...(pressed?.message ? { message: pressed.message } : {})}
        actions={actions}
        onClose={() => setPressed(null)}
      />
    </>
  )
}

const styles = themedStyleSheet(() => ({
  trail: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: { fontSize: typography.metaSize, color: colors.textMuted, fontVariant: ['tabular-nums'] }
}))
