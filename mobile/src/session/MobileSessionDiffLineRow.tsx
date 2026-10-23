import { Pressable, Text, View } from 'react-native'
import { MessageSquare, Plus, X } from 'lucide-react-native'
import { MobileDiffCodeLine } from '../components/MobileDiffCodeLine'
import { Button } from '../components/ui/Button'
import { IconButton } from '../components/ui/IconButton'
import { ReplyBox } from '../components/ui/ReplyBox'
import { pressTransition } from '../components/ui/transition-styles'
import { colors } from '../theme/mobile-theme'
import { sessionDiffLineStyles as styles } from './mobile-session-diff-line-styles'
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
  return (
    <View>
      <MobileDiffCodeLine
        line={line}
        selectable
        accessibilityLabel={`${title} diff line ${index + 1}`}
        trailing={
          commentLine !== undefined ? (
            <Pressable
              style={[styles.addTouch, commentsBusy && styles.disabled]}
              disabled={commentsBusy}
              onPress={() => onStartComment(commentLine)}
              accessibilityRole="button"
              accessibilityLabel={`Add note on line ${commentLine}`}
            >
              {({ pressed }) => (
                <View
                  style={[
                    styles.addMarker,
                    pressed && styles.addMarkerPressed,
                    pressed ? pressTransition.pressed : pressTransition.rest
                  ]}
                >
                  <Plus size={14} color={colors.textMuted} strokeWidth={2.3} />
                </View>
              )}
            </Pressable>
          ) : null
        }
      />
      {comments.length > 0 ? (
        <View style={styles.notes}>
          {comments.map((comment) => (
            <View key={comment.id} style={styles.note}>
              <MessageSquare
                size={14}
                color={colors.textMuted}
                strokeWidth={2.2}
                style={styles.noteIcon}
              />
              <View style={styles.noteMain}>
                <Text style={styles.noteMeta}>Line {comment.lineNumber}</Text>
                <Text style={styles.noteBody}>{comment.body}</Text>
              </View>
              <IconButton
                icon={X}
                variant="bare"
                iconSize={16}
                iconColor={colors.textMuted}
                disabled={commentsBusy}
                onPress={() => onDeleteComment(comment.id)}
                accessibilityLabel={`Delete note on line ${comment.lineNumber}`}
              />
            </View>
          ))}
        </View>
      ) : null}
      {isCommenting ? (
        <View style={styles.composer}>
          <ReplyBox
            value={commentDraft}
            onChangeText={onDraftChange}
            onSend={() => onSubmitComment(commentLine)}
            placeholder="Add review note"
            sendAccessibilityLabel="Save note"
            sending={commentsBusy}
            autoFocus
          />
          <View style={styles.composerActions}>
            <Button
              label="Cancel"
              variant="plain"
              size="compact"
              disabled={commentsBusy}
              onPress={onCancelComment}
            />
          </View>
        </View>
      ) : null}
    </View>
  )
}
