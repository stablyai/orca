import { View, Text, TextInput, Pressable } from 'react-native'
import { MessageSquare, Plus, X } from 'lucide-react-native'
import { MobileSyntaxSegments } from '../components/MobileSyntaxSegments'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-session-styles'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { RenderableDiffLine } from './mobile-session-route-types'

export function DiffLineRow({
  line,
  title,
  index,
  comments,
  activeCommentLine,
  commentDraft,
  commentsBusy,
  onStartComment,
  onCancelComment,
  onDraftChange,
  onSubmitComment,
  onDeleteComment
}: {
  line: RenderableDiffLine
  title: string
  index: number
  comments: DiffComment[]
  activeCommentLine: number | null
  commentDraft: string
  commentsBusy: boolean
  onStartComment: (lineNumber: number) => void
  onCancelComment: () => void
  onDraftChange: (value: string) => void
  onSubmitComment: (lineNumber: number) => void
  onDeleteComment: (commentId: string) => void
}) {
  const commentLine = line.newLineNumber
  const isCommenting = commentLine !== undefined && activeCommentLine === commentLine
  const canComment = commentLine !== undefined
  // Why: review notes anchor to the modified side, so show that line number in the single mobile gutter.
  const gutterLineNumber = line.newLineNumber ?? line.oldLineNumber ?? ''
  return (
    <View style={styles.diffLineBlock}>
      <View
        style={[
          styles.diffLine,
          line.kind === 'add' && styles.diffLineAdded,
          line.kind === 'delete' && styles.diffLineDeleted
        ]}
      >
        <Text style={styles.diffGutter}>{gutterLineNumber}</Text>
        <Text
          selectable
          style={styles.diffText}
          accessibilityLabel={`${title} diff line ${index + 1}`}
        >
          <Text
            style={[
              styles.diffPrefix,
              line.kind === 'add' && styles.diffPrefixAdded,
              line.kind === 'delete' && styles.diffPrefixDeleted
            ]}
          >
            {line.kind === 'add' ? '+ ' : line.kind === 'delete' ? '- ' : '  '}
          </Text>
          <MobileSyntaxSegments segments={line.segments} />
        </Text>
        {canComment ? (
          <Pressable
            style={({ pressed }) => [
              styles.diffCommentAddButton,
              pressed && styles.diffCommentAddButtonPressed,
              commentsBusy && styles.diffCommentButtonDisabled
            ]}
            disabled={commentsBusy}
            onPress={() => {
              if (commentLine !== undefined) {
                onStartComment(commentLine)
              }
            }}
            accessibilityLabel={`Add note on line ${commentLine}`}
          >
            <Plus size={12} color={colors.textSecondary} strokeWidth={2.3} />
          </Pressable>
        ) : null}
      </View>
      {comments.length > 0 ? (
        <View style={styles.diffCommentList}>
          {comments.map((comment) => (
            <View key={comment.id} style={styles.diffCommentCard}>
              <View style={styles.diffCommentHeader}>
                <MessageSquare size={12} color={colors.textMuted} strokeWidth={2.2} />
                <Text style={styles.diffCommentMeta}>Line {comment.lineNumber}</Text>
                <Pressable
                  style={styles.diffCommentDeleteButton}
                  disabled={commentsBusy}
                  onPress={() => onDeleteComment(comment.id)}
                  accessibilityLabel={`Delete note on line ${comment.lineNumber}`}
                >
                  <X size={12} color={colors.textMuted} strokeWidth={2.2} />
                </Pressable>
              </View>
              <Text style={styles.diffCommentBody}>{comment.body}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {isCommenting ? (
        <View style={styles.diffCommentComposer}>
          <TextInput
            style={[styles.textInput, styles.diffCommentInput]}
            value={commentDraft}
            onChangeText={onDraftChange}
            placeholder="Add review note"
            placeholderTextColor={colors.textMuted}
            editable={!commentsBusy}
            multiline
            textAlignVertical="top"
            autoFocus
          />
          <View style={styles.diffCommentComposerActions}>
            <Pressable
              style={styles.diffCommentSecondaryAction}
              disabled={commentsBusy}
              onPress={onCancelComment}
            >
              <Text style={styles.diffCommentSecondaryText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[
                styles.diffCommentPrimaryAction,
                (!commentDraft.trim() || commentsBusy) && styles.diffCommentButtonDisabled
              ]}
              disabled={!commentDraft.trim() || commentsBusy}
              onPress={() => {
                if (commentLine !== undefined) {
                  onSubmitComment(commentLine)
                }
              }}
            >
              <Text style={styles.diffCommentPrimaryText}>Save note</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  )
}
