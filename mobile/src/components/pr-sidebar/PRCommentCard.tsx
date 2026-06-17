import { Image, Linking, Pressable, Text, View } from 'react-native'
import { ExternalLink } from 'lucide-react-native'
import type { GitHubReaction, GitHubReactionContent, PRComment } from '../../../../src/shared/types'
import { colors } from '../../theme/mobile-theme'
import { CommentMarkdown } from './CommentMarkdown'
import { formatPrCommentRelativeTime } from './pr-comment-time'
import { prCommentsStyles as styles } from './pr-comments-styles'

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

// One PR comment (or review-thread reply), mirroring the desktop comment card:
// avatar + author + relative time + inline file:line + resolved chip + open-on-
// GitHub, then the markdown body and reactions. Read-only (no reply/edit yet).
export function PRCommentCard({
  comment,
  isReply = false
}: {
  comment: PRComment
  isReply?: boolean
}) {
  const fileLabel = comment.path
    ? `${comment.path.split('/').pop()}${comment.line ? `:L${comment.line}` : ''}`
    : null
  return (
    <View style={[styles.card, isReply && styles.reply, comment.isResolved && styles.cardResolved]}>
      <View style={styles.header}>
        {comment.authorAvatarUrl ? (
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
        <Text style={styles.time}>
          · {formatPrCommentRelativeTime(comment.createdAt, Date.now())}
        </Text>
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
            onPress={() => void Linking.openURL(comment.url)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Open comment on GitHub"
          >
            <ExternalLink size={14} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.body}>
        <CommentMarkdown content={comment.body} />
        <Reactions reactions={comment.reactions} />
      </View>
    </View>
  )
}
