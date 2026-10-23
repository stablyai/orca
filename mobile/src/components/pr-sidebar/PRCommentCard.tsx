import { memo, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { openExternalLink } from '../../platform/external-link'
import {
  Check,
  CornerDownRight,
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Trash2,
  Undo2
} from 'lucide-react-native'
import type {
  GitHubReaction,
  GitHubReactionContent,
  PRComment
} from '../../../../src/shared/github/comment-types'
import { colors } from '../../theme/mobile-theme'
import { canEditComment, isResolvableComment } from '../../session/pr-comment-actions'
import { ActionSheetModal, type ActionSheetAction } from '../ActionSheetModal'
import { ConfirmModal } from '../ConfirmModal'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { PRAvatar } from './PRAvatar'
import { CommentMarkdown } from './CommentMarkdown'
import { PRCommentComposer } from './PRCommentComposer'
import { formatPrCommentRelativeTime } from '../../../../src/shared/pr-comment-time'
import { prCommentsStyles as styles } from './pr-comments-styles'

export type PRCommentRepoSlug = { owner: string; repo: string; host?: string }

// Action handlers are passed from the comment actions hook (stable callbacks), so
// adding them keeps the memo'd card from re-rendering on unrelated timeline changes.
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
          <Text style={styles.reactionEmoji}>{REACTION_EMOJI[r.content]}</Text>
          <Text style={styles.reactionText}>{r.count}</Text>
        </View>
      ))}
    </View>
  )
}

// One PR comment (or review-thread reply), read like a thread: avatar, author and time on one
// line, the file:line it sits on, the markdown body and reactions. Reply is the one visible
// action; Edit, Delete, Resolve and Open on GitHub sit in the trailing menu.
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
  const [menuOpen, setMenuOpen] = useState(false)
  const fileLabel = comment.path
    ? `${comment.path.split('/').pop()}${comment.line ? `:L${comment.line}` : ''}`
    : null
  const canResolve = actions ? isResolvableComment(comment) : false
  const resolveBusy =
    canResolve && actions ? actions.isResolveBusy(comment.threadId as string) : false
  const replyBusy = actions ? actions.isReplyBusy(comment.id) : false
  // Edit/delete are offered only on mutable root conversation comments with a repo
  // slug; GitHub enforces authorship server-side (no client viewer-identity field).
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

  const menuActions: ActionSheetAction[] = []
  if (actions && canMutate) {
    menuActions.push({
      label: 'Edit comment',
      icon: Pencil,
      disabled: editBusy,
      closeBeforePress: true,
      // Only one composer open at a time: entering Edit closes any open Reply.
      onPress: () => {
        setReplyOpen(false)
        setEditOpen(true)
      }
    })
  }
  if (actions && canResolve) {
    menuActions.push({
      label: comment.isResolved ? 'Unresolve thread' : 'Resolve thread',
      icon: comment.isResolved ? Undo2 : Check,
      disabled: resolveBusy,
      onPress: () => void actions.toggleResolve(comment)
    })
  }
  if (comment.url) {
    menuActions.push({
      label: 'Open on GitHub',
      icon: ExternalLink,
      onPress: () => openExternalLink(comment.url)
    })
  }
  if (actions && canMutate) {
    menuActions.push({
      label: 'Delete comment',
      icon: Trash2,
      destructive: true,
      disabled: deleteBusy,
      closeBeforePress: true,
      onPress: () => setConfirmDelete(true)
    })
  }
  const menuBusy = deleteBusy || resolveBusy

  return (
    <View style={[styles.card, isReply && styles.reply]}>
      <PRAvatar login={comment.author} url={comment.authorAvatarUrl} />
      <View style={styles.main}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <View style={styles.authorLine}>
              <Text
                style={[styles.author, comment.isResolved && styles.authorResolved]}
                numberOfLines={1}
              >
                {comment.author}
              </Text>
              <Text style={styles.time} numberOfLines={1}>
                {formatPrCommentRelativeTime(comment.createdAt, now)}
              </Text>
              {comment.isResolved ? <Badge label="Resolved" /> : null}
            </View>
            {fileLabel ? (
              <Text style={styles.path} numberOfLines={1}>
                {fileLabel}
              </Text>
            ) : null}
          </View>
          {menuBusy ? (
            <View style={styles.menuSlot}>
              <ActivityIndicator color={colors.textSecondary} />
            </View>
          ) : menuActions.length > 0 ? (
            <IconButton
              icon={MoreHorizontal}
              variant="bare"
              iconSize={18}
              iconColor={colors.textSecondary}
              onPress={() => setMenuOpen(true)}
              accessibilityLabel={`Comment actions for ${comment.author}`}
            />
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
          <View style={[styles.body, comment.isResolved && styles.bodyResolved]}>
            <CommentMarkdown content={comment.body} />
            <Reactions reactions={comment.reactions} />
          </View>
        )}
        {/* Replying to a reply lands in the same thread, so only the thread's first card offers it. */}
        {actions && !editOpen && !isReply && !replyOpen ? (
          <View style={styles.actionsRow}>
            <Button
              label="Reply"
              icon={CornerDownRight}
              variant="plain"
              size="compact"
              busy={replyBusy}
              onPress={() => setReplyOpen(true)}
              accessibilityLabel="Reply to comment"
            />
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
      </View>
      {menuActions.length > 0 ? (
        <ActionSheetModal
          visible={menuOpen}
          title="Comment"
          message={`${comment.author} · ${formatPrCommentRelativeTime(comment.createdAt, now)}`}
          actions={menuActions}
          onClose={() => setMenuOpen(false)}
        />
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
