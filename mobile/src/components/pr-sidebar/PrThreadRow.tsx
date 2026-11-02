import { useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import {
  ExternalLink,
  FileText,
  MoreHorizontal,
  Pencil,
  Sparkles,
  Trash2
} from 'lucide-react-native'
import type { PRComment } from '../../../../src/shared/github/comment-types'
import {
  getPRCommentGroupRoot,
  type PRCommentGroup
} from '../../../../src/shared/pr-comment-groups'
import { isBotPRComment } from '../../../../src/shared/pr-comment-audience'
import { threadDiffLines } from '../../../../src/shared/github/pr-comment-diff-hunk'
import { colors, pressedStyle, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { openExternalLink } from '../../platform/external-link'
import { canEditComment, isResolvableComment } from '../../session/pr-comment-actions'
import { ConfirmModal } from '../ConfirmModal'
import { PullDownMenu } from '../nav-bar/PullDownMenu'
import type { ActionSheetAction } from '../ActionSheetModal'
import { CommentMarkdown } from './CommentMarkdown'
import { PRCommentComposer } from './PRCommentComposer'
import { PrCommentAvatar } from './PrCommentAvatar'
import { PrThreadCode } from './PrThreadCode'
import { PrTextLink } from './PrTextLink'
import { commentRelativeTime } from './pr-comment-relative-time'
import { prCommentSeverity, type PrCommentSeverity } from './pr-comment-severity'

export type PRCommentRepoSlug = { owner: string; repo: string; host?: string }

// Stable hook callbacks, so a row re-renders only when its own thread changes.
export type PrThreadActions = {
  reply: (comment: PRComment, body: string) => Promise<boolean>
  toggleResolve: (comment: PRComment) => Promise<boolean>
  editComment: (commentId: number, body: string) => Promise<boolean>
  deleteComment: (commentId: number) => Promise<boolean>
  isReplyBusy: (commentId: number) => boolean
  isResolveBusy: (threadId: string) => boolean
  isEditBusy: (commentId: number) => boolean
  isDeleteBusy: (commentId: number) => boolean
  // Repo slug for the slug-addressed edit/delete RPCs; gates the affordances when absent.
  prRepo: PRCommentRepoSlug | null
}

export type PrAskToFix = { label: string; onPress: () => void; busy: boolean; disabled: boolean }

export const PR_COMMENT_AVATAR = 28
export const PR_COMMENT_INDENT = PR_COMMENT_AVATAR + spacing.md

export function prCommentLocation(comment: PRComment): string | null {
  if (!comment.path) {
    return null
  }
  const file = comment.path.split('/').pop() ?? comment.path
  return comment.line ? `${file}:${comment.line}` : file
}

// The bot tag already says it, so "[bot]" would repeat.
export function prCommentAuthorName(login: string): string {
  return login.replace(/\[bot\]$/i, '')
}

// One thread as a message: who, where, what they said, the latest reply in a line, then text links.
export function PrThreadRow({
  group,
  actions,
  botAuthorOverrides,
  now,
  onOpenFile,
  onOpenThread,
  askToFix
}: {
  group: PRCommentGroup
  actions?: PrThreadActions
  botAuthorOverrides: ReadonlySet<string>
  now: number
  onOpenFile?: (filePath: string) => void
  onOpenThread?: (focusReply: boolean) => void
  /** Bot findings offer the same agent launch as desktop's Resolve comments with AI. */
  askToFix?: PrAskToFix
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<View>(null)
  const root = getPRCommentGroupRoot(group)
  const replies = group.kind === 'thread' ? group.replies : []
  const lastReply = replies.at(-1)
  const bot = isBotPRComment(root, botAuthorOverrides)
  const severity = bot ? prCommentSeverity(root.body) : null
  const location = prCommentLocation(root)
  const filePath = root.path
  const canResolve = actions !== undefined && isResolvableComment(root)
  const resolveBusy = canResolve && root.threadId ? actions.isResolveBusy(root.threadId) : false
  const canMutate =
    actions !== undefined && group.kind === 'standalone' && canEditComment(root, actions.prRepo)
  const openThread = group.kind === 'thread' && onOpenThread ? () => onOpenThread(false) : undefined
  const ask =
    askToFix && bot && group.kind === 'thread' && root.isResolved !== true ? askToFix : null
  const replyInThread =
    group.kind === 'thread' && onOpenThread ? () => onOpenThread(true) : undefined
  const menuGroups: ActionSheetAction[][] = [
    root.url
      ? [
          {
            label: t('pullRequest.screens.openOnGitHub', 'Open on GitHub'),
            icon: ExternalLink,
            onPress: () => openExternalLink(root.url)
          }
        ]
      : [],
    canMutate
      ? [
          {
            label: t('common.edit', 'Edit'),
            icon: Pencil,
            closeBeforePress: true,
            onPress: () => setEditing(true)
          },
          {
            label: t('common.delete', 'Delete'),
            icon: Trash2,
            destructive: true,
            closeBeforePress: true,
            loading: actions.isDeleteBusy(root.id),
            onPress: () => setConfirmDelete(true)
          }
        ]
      : []
  ].filter((items) => items.length > 0)
  const content = (
    <>
      <View style={styles.head}>
        <PrCommentAvatar login={root.author} size={PR_COMMENT_AVATAR} />
        <Text style={styles.author} numberOfLines={1}>
          {prCommentAuthorName(root.author)}
        </Text>
        {bot ? <Text style={styles.botTag}>{t('pullRequest.screens.bot', 'bot')}</Text> : null}
        <Text style={styles.time} numberOfLines={1}>
          {commentRelativeTime(root.createdAt, now, t)}
        </Text>
        <View style={styles.spacer} />
        {severity ? <SeverityPill severity={severity} /> : null}
        {canMutate && actions.isDeleteBusy(root.id) ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : null}
        {menuGroups.length > 0 ? (
          <Pressable
            ref={menuRef}
            onPress={() => setMenuOpen(true)}
            hitSlop={8}
            style={({ pressed }) => [styles.more, pressed && styles.morePressed]}
            accessibilityRole="button"
            accessibilityLabel={t('pullRequest.screens.commentActions', 'More for this comment')}
          >
            <MoreHorizontal size={18} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.body}>
        {location ? (
          <PrCommentFileLink
            location={location}
            onPress={filePath && onOpenFile ? () => onOpenFile(filePath) : openThread}
          />
        ) : null}
        {root.diffHunk && root.line ? (
          <PrThreadCode lines={threadDiffLines(root.diffHunk, root.line).slice(-1)} />
        ) : null}
        {editing && actions ? (
          <PRCommentComposer
            placeholder={t('pullRequest.commentCard.editPlaceholder', 'Edit comment…')}
            submitLabel={t('common.save', 'Save')}
            submitting={actions.isEditBusy(root.id)}
            initialBody={root.body}
            onSubmit={async (body) => {
              const ok = await actions.editComment(root.id, body)
              if (ok) {
                setEditing(false)
              }
              return ok
            }}
            onCancel={() => setEditing(false)}
            autoFocus
          />
        ) : (
          <CommentMarkdown content={root.body} />
        )}
        {lastReply ? (
          <View style={styles.reply}>
            <PrCommentAvatar login={lastReply.author} size={16} />
            <Text style={styles.replyText} numberOfLines={1}>
              <Text style={styles.replyAuthor}>{prCommentAuthorName(lastReply.author)}</Text>
              {'  '}
              {replies.length > 1
                ? t('pullRequest.screens.replyAndMore', '{{body}} (+{{count}} more)', {
                    body: lastReply.body.replaceAll('`', '').trim(),
                    count: replies.length - 1
                  })
                : lastReply.body.replaceAll('`', '').trim()}
            </Text>
          </View>
        ) : null}
        {actions && !editing && (openThread || canResolve) ? (
          <View style={styles.links}>
            {ask ? (
              <PrTextLink
                accent
                icon={<Sparkles size={14} color={colors.accentBlue} strokeWidth={2.2} />}
                label={ask.label}
                onPress={ask.onPress}
                busy={ask.busy}
                disabled={ask.disabled}
              />
            ) : openThread ? (
              <PrTextLink
                label={t('pullRequest.commentCard.reply', 'Reply')}
                onPress={replyInThread ?? openThread}
              />
            ) : null}
            {canResolve ? (
              <PrTextLink
                label={
                  root.isResolved
                    ? t('pullRequest.commentCard.unresolve', 'Unresolve')
                    : t('pullRequest.commentCard.resolve', 'Resolve')
                }
                onPress={() => void actions.toggleResolve(root)}
                busy={resolveBusy}
              />
            ) : null}
          </View>
        ) : null}
      </View>
    </>
  )
  return (
    <>
      {/* Touch only: a button role would hide the links and ⋯ inside from VoiceOver; Reply opens the thread. */}
      {openThread ? (
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={openThread}
        >
          {content}
        </Pressable>
      ) : (
        <View style={styles.row}>{content}</View>
      )}
      {/* Siblings of the row, so a tap on a closing menu cannot bubble into it and open the thread. */}
      {menuGroups.length > 0 ? (
        <PullDownMenu
          visible={menuOpen}
          anchorRef={menuRef}
          groups={menuGroups}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
      {canMutate ? (
        <ConfirmModal
          visible={confirmDelete}
          title={t('pullRequest.commentCard.deleteConfirmTitle', 'Delete comment?')}
          message={t(
            'pullRequest.commentCard.deleteConfirmMessage',
            'This permanently deletes the comment on GitHub.'
          )}
          confirmLabel={t('common.delete', 'Delete')}
          destructive
          onConfirm={() => void actions.deleteComment(root.id)}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </>
  )
}

export function PrCommentFileLink({
  location,
  onPress
}: {
  location: string
  onPress?: () => void
}) {
  useMobileColorScheme()
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      hitSlop={4}
      accessibilityRole={onPress ? 'link' : undefined}
      style={({ pressed }) => [styles.file, pressed && pressedStyle]}
    >
      <FileText size={12} color={colors.textMuted} strokeWidth={2} />
      <Text style={styles.fileText} numberOfLines={1}>
        {location}
      </Text>
    </Pressable>
  )
}

function SeverityPill({ severity }: { severity: PrCommentSeverity }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const color =
    severity === 'critical'
      ? colors.statusRed
      : severity === 'major'
        ? colors.statusAmber
        : colors.textSecondary
  const label = {
    critical: t('pullRequest.screens.severityCritical', 'Critical'),
    major: t('pullRequest.screens.severityMajor', 'Major'),
    minor: t('pullRequest.screens.severityMinor', 'Minor'),
    trivial: t('pullRequest.screens.severityTrivial', 'Trivial')
  }[severity]
  return (
    <View style={[styles.severity, { borderColor: color }]}>
      <Text style={[styles.severityText, { color }]}>{label}</Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  rowPressed: { backgroundColor: colors.bgPanel },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 32 },
  author: { color: colors.textPrimary, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  botTag: {
    color: colors.textSecondary,
    fontSize: 11,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.mark,
    paddingHorizontal: 5,
    overflow: 'hidden'
  },
  time: { color: colors.textMuted, fontSize: typography.metaSize, flexShrink: 0 },
  spacer: { flex: 1 },
  more: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  morePressed: { backgroundColor: colors.bgRaised },
  body: { marginLeft: PR_COMMENT_INDENT, gap: spacing.sm },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    maxWidth: '100%'
  },
  fileText: {
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    flexShrink: 1
  },
  reply: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  replyText: { flex: 1, color: colors.textSecondary, fontSize: 13 },
  replyAuthor: { color: colors.textPrimary, fontWeight: '600' },
  links: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl, minHeight: 28 },
  severity: {
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1
  },
  severityText: { fontSize: typography.metaSize, fontWeight: '600' }
}))
