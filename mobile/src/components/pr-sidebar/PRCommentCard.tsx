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
import { canEditComment, isResolvableComment } from '../../session/pr-comment-actions'
import { ConfirmModal } from '../ConfirmModal'
import { CommentMarkdown } from './CommentMarkdown'
import { PRCommentComposer } from './PRCommentComposer'
import { formatPrCommentRelativeTime } from '../../../../src/shared/pr-comment-time'
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

function Reactions({ reactions }: { reactions?: GitHubReaction[] }) {
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
        <Text style={styles.time}>· {formatPrCommentRelativeTime(comment.createdAt, now)}</Text>
        {fileLabel ? (
          <Text style={styles.path} numberOfLines={1}>
            {fileLabel}
          </Text>
        ) : null}
        {comment.isResolved ? (
          <View style={styles.resolvedChip}>
            <Text style={styles.resolvedChipText}>resolved</Text>
          </View>
        ) : null}
        {comment.url ? (
          <Pressable
            style={styles.openButton}
            onPress={() => openExternalLink(comment.url)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Open comment on GitHub"
          >
            <ExternalLink size={14} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
        ) : null}
      </View>
      {editOpen && actions ? (
        <View style={styles.composer}>
          <PRCommentComposer
            placeholder="Edit comment…"
            submitLabel="Save"
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
            accessibilityLabel="Reply to comment"
          >
            <CornerDownRight size={13} color={colors.textSecondary} strokeWidth={2.2} />
            <Text style={styles.actionButtonText}>Reply</Text>
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
              accessibilityLabel="Edit comment"
            >
              <Pencil size={13} color={colors.textSecondary} strokeWidth={2.2} />
              <Text style={styles.actionButtonText}>Edit</Text>
            </Pressable>
          ) : null}
          {canMutate ? (
            <Pressable
              style={({ pressed }) => [styles.actionButton, pressed && styles.actionButtonPressed]}
              onPress={() => setConfirmDelete(true)}
              disabled={deleteBusy}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Delete comment"
            >
              <Trash2 size={13} color={colors.textSecondary} strokeWidth={2.2} />
              <Text style={styles.actionButtonText}>{deleteBusy ? '…' : 'Delete'}</Text>
            </Pressable>
          ) : null}
          {canResolve ? (
            <Pressable
              style={({ pressed }) => [styles.actionButton, pressed && styles.actionButtonPressed]}
              onPress={() => void actions.toggleResolve(comment)}
              disabled={resolveBusy}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={comment.isResolved ? 'Unresolve thread' : 'Resolve thread'}
            >
              {comment.isResolved ? (
                <Undo2 size={13} color={colors.textSecondary} strokeWidth={2.2} />
              ) : (
                <Check size={13} color={colors.textSecondary} strokeWidth={2.2} />
              )}
              <Text style={styles.actionButtonText}>
                {resolveBusy ? '…' : comment.isResolved ? 'Unresolve' : 'Resolve'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {replyOpen && !editOpen && actions ? (
        <View style={styles.composer}>
          <PRCommentComposer
            placeholder="Write a reply…"
            submitLabel="Reply"
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
          title="Delete comment?"
          message="This permanently deletes the comment on GitHub."
          confirmLabel="Delete"
          destructive
          onConfirm={() => void actions.deleteComment(comment.id)}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </View>
  )
})
