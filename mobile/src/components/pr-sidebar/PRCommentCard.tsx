import { memo, useState } from 'react'
import { Image, Platform, Pressable, Text, View } from 'react-native'
import { openExternalLink } from '../../platform/external-link'
import { Check, CornerDownRight, ExternalLink, Pencil, Trash2, Undo2 } from 'lucide-react-native'
import type {
  GitHubReaction,
  GitHubReactionContent,
  PRComment
} from '../../../../src/shared/github/comment-types'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { canEditComment, isResolvableComment } from '../../session/pr-comment-actions'
import { ConfirmModal } from '../ConfirmModal'
import { CommentMarkdown } from './CommentMarkdown'
import { PRCommentComposer } from './PRCommentComposer'
import { prCommentsStyles as styles } from './pr-comments-styles'

export type PRCommentRepoSlug = { owner: string; repo: string; host?: string }

// Keep hook callbacks stable so memoized cards skip unrelated timeline updates.
export type PRCommentCardActions = {
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

const REACTION_EMOJI: Record<GitHubReactionContent, string> = {
  '+1': '👍',
  '-1': '👎',
  laugh: '😄',
  confused: '😕',
  heart: '❤️',
  hooray: '🎉',
  rocket: '🚀',
  eyes: '👀'
}

function commentRelativeTime(iso: string, now: number, t: Translate): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) {
    return ''
  }
  const delta = now - timestamp
  if (delta < 60_000) {
    return t('pullRequest.commentCard.justNow', 'just now')
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    const count = minutes
    return count === 1
      ? t('pullRequest.commentCard.minutesAgo_one', '{{count}}m ago', { count })
      : t('pullRequest.commentCard.minutesAgo_other', '{{count}}m ago', { count })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const count = hours
    return count === 1
      ? t('pullRequest.commentCard.hoursAgo_one', '{{count}}h ago', { count })
      : t('pullRequest.commentCard.hoursAgo_other', '{{count}}h ago', { count })
  }
  const days = Math.floor(hours / 24)
  if (days < 30) {
    const count = days
    return count === 1
      ? t('pullRequest.commentCard.daysAgo_one', '{{count}}d ago', { count })
      : t('pullRequest.commentCard.daysAgo_other', '{{count}}d ago', { count })
  }
  const months = Math.floor(days / 30)
  if (months < 12) {
    const count = months
    return count === 1
      ? t('pullRequest.commentCard.monthsAgo_one', '{{count}}mo ago', { count })
      : t('pullRequest.commentCard.monthsAgo_other', '{{count}}mo ago', { count })
  }
  const count = Math.floor(months / 12)
  return count === 1
    ? t('pullRequest.commentCard.yearsAgo_one', '{{count}}y ago', { count })
    : t('pullRequest.commentCard.yearsAgo_other', '{{count}}y ago', { count })
}

function Reactions({ reactions }: { reactions?: GitHubReaction[] }) {
  useMobileColorScheme()
  const visible = (reactions ?? []).filter((r) => r.count > 0)
  if (visible.length === 0) {
    return null
  }
  return (
    <View style={styles.reactionsRow}>
      {visible.map((r) => (
        <View key={r.content} style={styles.reactionChip}>
          <Text>{REACTION_EMOJI[r.content]}</Text>
          <Text style={styles.reactionText}>{r.count}</Text>
        </View>
      ))}
    </View>
  )
}

// Match desktop comment identity/file/resolved/body/reactions; optional actions add Reply and review-thread Resolve controls.
export const PRCommentCard = memo(function PRCommentCard({
  comment,
  isReply = false,
  actions,
  now
}: {
  comment: PRComment
  isReply?: boolean
  actions?: PRCommentCardActions
  now: number
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [replyOpen, setReplyOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const fileLabel = comment.path
    ? `${comment.path.split('/').pop()}${comment.line ? `:L${comment.line}` : ''}`
    : null
  const canResolve = actions ? isResolvableComment(comment) : false
  const resolveBusy =
    canResolve && actions ? actions.isResolveBusy(comment.threadId as string) : false
  const replyBusy = actions ? actions.isReplyBusy(comment.id) : false
  // Offer edit/delete only for mutable root comments with repo slug; GitHub enforces authorship without client viewer identity.
  const canMutate = actions ? canEditComment(comment, actions.prRepo) : false
  const editBusy = actions ? actions.isEditBusy(comment.id) : false
  const deleteBusy = actions ? actions.isDeleteBusy(comment.id) : false

  const submitReply = async (body: string): Promise<boolean> => {
    if (!actions) {
      return false
    }
    const ok = await actions.reply(comment, body)
    if (ok) {
      setReplyOpen(false)
    }
    return ok
  }

  const submitEdit = async (body: string): Promise<boolean> => {
    if (!actions) {
      return false
    }
    const ok = await actions.editComment(comment.id, body)
    if (ok) {
      setEditOpen(false)
    }
    return ok
  }

  return (
    <View style={[styles.card, isReply && styles.reply, comment.isResolved && styles.cardResolved]}>
      <View style={styles.header}>
        {/* Page avatars remain deferred (ruling 26); https is now permitted, so skip reflects missing capability rather than CSP refusal. */}
        {comment.authorAvatarUrl && Platform.OS !== 'web' ? (
          <Image source={{ uri: comment.authorAvatarUrl }} style={styles.avatar} />
        ) : (
          <View style={styles.avatar} />
        )}
        <Text
          style={[styles.author, comment.isResolved && styles.authorResolved]}
          numberOfLines={1}
        >
          {comment.author}
        </Text>
        <Text style={styles.time}>· {commentRelativeTime(comment.createdAt, now, t)}</Text>
        {fileLabel ? (
          <Text style={styles.path} numberOfLines={1}>
            {fileLabel}
          </Text>
        ) : null}
        {comment.isResolved ? (
          <View style={styles.resolvedChip}>
            <Text style={styles.resolvedChipText}>
              {t('pullRequest.commentCard.resolved', 'resolved')}
            </Text>
          </View>
        ) : null}
        {comment.url ? (
          <Pressable
            style={styles.openButton}
            onPress={() => openExternalLink(comment.url)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('pullRequest.commentCard.openOnGitHub', 'Open comment on GitHub')}
          >
            <ExternalLink size={14} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
        ) : null}
      </View>
      {editOpen && actions ? (
        <View style={styles.composer}>
          <PRCommentComposer
            placeholder={t('pullRequest.commentCard.editPlaceholder', 'Edit comment…')}
            submitLabel={t('common.save', 'Save')}
            submitting={editBusy}
            initialBody={comment.body}
            onSubmit={submitEdit}
            onCancel={() => setEditOpen(false)}
            autoFocus
          />
        </View>
      ) : (
        <View style={styles.body}>
          <CommentMarkdown content={comment.body} />
          <Reactions reactions={comment.reactions} />
        </View>
      )}
      {actions && !editOpen ? (
        <View style={styles.actionsRow}>
          <Pressable
            style={({ pressed }) => [styles.actionButton, pressed && styles.actionButtonPressed]}
            onPress={() => setReplyOpen((v) => !v)}
            disabled={replyBusy}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={t('pullRequest.commentCard.replyToComment', 'Reply to comment')}
          >
            <CornerDownRight size={13} color={colors.textSecondary} strokeWidth={2.2} />
            <Text style={styles.actionButtonText}>
              {t('pullRequest.commentCard.reply', 'Reply')}
            </Text>
          </Pressable>
          {canMutate ? (
            <Pressable
              style={({ pressed }) => [styles.actionButton, pressed && styles.actionButtonPressed]}
              onPress={() => {
                // Only one composer open at a time: entering Edit closes any open Reply.
                setReplyOpen(false)
                setEditOpen(true)
              }}
              disabled={editBusy}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={t('pullRequest.commentCard.editComment', 'Edit comment')}
            >
              <Pencil size={13} color={colors.textSecondary} strokeWidth={2.2} />
              <Text style={styles.actionButtonText}>{t('common.edit', 'Edit')}</Text>
            </Pressable>
          ) : null}
          {canMutate ? (
            <Pressable
              style={({ pressed }) => [styles.actionButton, pressed && styles.actionButtonPressed]}
              onPress={() => setConfirmDelete(true)}
              disabled={deleteBusy}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={t('pullRequest.commentCard.deleteComment', 'Delete comment')}
            >
              <Trash2 size={13} color={colors.textSecondary} strokeWidth={2.2} />
              <Text style={styles.actionButtonText}>
                {deleteBusy ? '…' : t('common.delete', 'Delete')}
              </Text>
            </Pressable>
          ) : null}
          {canResolve ? (
            <Pressable
              style={({ pressed }) => [styles.actionButton, pressed && styles.actionButtonPressed]}
              onPress={() => void actions.toggleResolve(comment)}
              disabled={resolveBusy}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={
                comment.isResolved
                  ? t('pullRequest.commentCard.unresolveThread', 'Unresolve thread')
                  : t('pullRequest.commentCard.resolveThread', 'Resolve thread')
              }
            >
              {comment.isResolved ? (
                <Undo2 size={13} color={colors.textSecondary} strokeWidth={2.2} />
              ) : (
                <Check size={13} color={colors.textSecondary} strokeWidth={2.2} />
              )}
              <Text style={styles.actionButtonText}>
                {resolveBusy
                  ? '…'
                  : comment.isResolved
                    ? t('pullRequest.commentCard.unresolve', 'Unresolve')
                    : t('pullRequest.commentCard.resolve', 'Resolve')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {replyOpen && !editOpen && actions ? (
        <View style={styles.composer}>
          <PRCommentComposer
            placeholder={t('pullRequest.commentCard.replyPlaceholder', 'Write a reply…')}
            submitLabel={t('pullRequest.commentCard.reply', 'Reply')}
            submitting={replyBusy}
            onSubmit={submitReply}
            onCancel={() => setReplyOpen(false)}
            autoFocus
          />
        </View>
      ) : null}
      {actions ? (
        <ConfirmModal
          visible={confirmDelete}
          title={t('pullRequest.commentCard.deleteConfirmTitle', 'Delete comment?')}
          message={t(
            'pullRequest.commentCard.deleteConfirmMessage',
            'This permanently deletes the comment on GitHub.'
          )}
          confirmLabel={t('common.delete', 'Delete')}
          destructive
          onConfirm={() => void actions.deleteComment(comment.id)}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </View>
  )
})
