// One of an item's links as a phone row, in the desktop's rows (shared botItemLinkRows): workers as the chats
// tree draws them, PRs and issues with live state, web links, files. What the desktop's hover tooltip says
// (state, checks, repo) is the row's accessibility label and its long-press sheet's message.
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
  botItemWorkerRow,
  botItemWorkerState,
  type BotItemGitHubRow,
  type BotItemLinkRow
} from '../../../../src/shared/bots/bot-item-link-rows'
import type { BotChatTreeWorker } from '../../../../src/shared/bots/bot-chat-tree'
import { ListRow } from '../../components/list/ListGroup'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import { openExternalLink } from '../../platform/external-links/external-link'
import { spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { prStateColor } from '../../worktree/row-presentation/WorktreeMetaGlyphs'
import { MobileConnectorLogo } from '../MobileConnectorSourceIcon'
import { MobileBotWorkerRow } from '../MobileBotWorkerRow'

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
  const colors = useMobileColors()
  if (!row.state) {
    return row.type === 'pr' ? (
      <GitPullRequest size={ICON} color={colors.textMuted} />
    ) : (
      <CircleDot size={ICON} color={colors.textMuted} />
    )
  }
  if (row.type === 'issue') {
    return row.state === 'closed' ? (
      <CircleCheck size={ICON} color={prStateColor('merged', colors)} />
    ) : (
      <CircleDot size={ICON} color={prStateColor('open', colors)} />
    )
  }
  const color = prStateColor(row.state, colors)
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
  const colors = useMobileColors()
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

/** What a link says in the UI's language beyond its name, so a search for "failed" or "merged" finds it. */
export function botItemLinkSearchWords(row: BotItemLinkRow, t: Translate): string {
  if (row.kind === 'github') {
    return [stateWord(row, t), checksWord(row.checks, t)].filter(Boolean).join('\n')
  }
  if (row.kind !== 'worker') {
    return ''
  }
  switch (botItemWorkerState(row.link.state)) {
    case 'running':
      return t('agents.sections.working', 'Working')
    case 'failed':
      return t('worktree.agentRowDisplay.failed', 'Failed')
    case 'done':
      return t('worktree.agentRowDisplay.done', 'Done')
    case 'unreachable':
      return t('bots.chats.statusUnknown', 'Status unknown')
  }
}

/** What a long press on a link offers: its full name and line, and what Copy copies. */
export type BotItemLinkPress = { title: string; message?: string; url?: string; copy: string }

export function MobileBotItemLinkRow({
  bot,
  entry,
  onOpenWorker,
  onOpenFile,
  onLongPress
}: {
  bot: { id: string; name: string }
  entry: BotItemLinkRow
  onOpenWorker: (worker: BotChatTreeWorker) => void
  /** Opens a file in the bot's folder; refuses one outside it. */
  onOpenFile: (path: string) => void
  onLongPress: (press: BotItemLinkPress) => void
}): React.JSX.Element {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  switch (entry.kind) {
    case 'worker': {
      const worker = botItemWorkerRow(entry.link)
      return (
        <MobileBotWorkerRow
          bot={bot}
          worker={worker}
          nested={false}
          onOpen={worker.neverStarted ? undefined : () => onOpenWorker(worker)}
        />
      )
    }
    case 'github': {
      const title = gitHubTitle(entry, t)
      const line = gitHubStateLine(entry, t)
      const where = `${entry.showRepo ? entry.repo : ''}#${entry.number}`
      return (
        <ListRow
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
          onLongPress={() => onLongPress({ title, message: line, url: entry.url, copy: entry.url })}
        />
      )
    }
    case 'server-pr':
      return (
        <ListRow
          title={t('bots.items.link.serverPr', 'PR not shown for server work yet')}
          leading={<GitPullRequest size={ICON} color={colors.textMuted} />}
          disabled
        />
      )
    case 'web':
      return (
        <ListRow
          title={entry.title}
          leading={
            entry.brand ? (
              <MobileConnectorLogo source={entry.brand} />
            ) : (
              <Link2 size={ICON} color={colors.textMuted} />
            )
          }
          accessibilityLabel={`${entry.title}, ${entry.tip}`}
          onPress={() => openExternalLink(entry.url)}
          onLongPress={() =>
            onLongPress({
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
          title={entry.name}
          leading={<FileText size={ICON} color={colors.textMuted} />}
          accessibilityLabel={`${entry.name}, ${entry.path}`}
          onPress={() => onOpenFile(entry.path)}
          onLongPress={() =>
            onLongPress({ title: entry.name, message: entry.path, copy: entry.path })
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
          title={title}
          subtitle={line}
          leading={<Hourglass size={ICON} color={colors.textMuted} />}
          disabled={!entry.active}
        />
      )
    }
  }
}

const stylesSheet = themedStyleSheet((colors) => ({
  trail: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: { fontSize: typography.metaSize, color: colors.textMuted, fontVariant: ['tabular-nums'] }
}))
