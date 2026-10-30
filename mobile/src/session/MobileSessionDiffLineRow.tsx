import { View, Text, Pressable } from 'react-native'
import { MessageSquare, Plus, X } from 'lucide-react-native'
import { MobileSyntaxSegments } from '../components/MobileSyntaxSegments'
import { MessageBox } from '../components/composer-input/MessageBox'
import { composerInputStyles } from '../components/composer-input/composer-input-styles'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
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
  useMobileColorScheme()
  const t = useMobileTranslation()
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
          accessibilityLabel={t(
            'session.diffLineRow.diffLineLabel',
            '{{title}} diff line {{line}}',
            {
              title,
              line: index + 1
            }
          )}
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
            accessibilityLabel={t('session.diffLineRow.addNoteLabel', 'Add note on line {{line}}', {
              line: commentLine
            })}
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
                <Text style={styles.diffCommentMeta}>
                  {t('session.diffLineRow.lineNumber', 'Line {{line}}', {
                    line: comment.lineNumber
                  })}
                </Text>
                <Pressable
                  style={styles.diffCommentDeleteButton}
                  disabled={commentsBusy}
                  onPress={() => onDeleteComment(comment.id)}
                  accessibilityLabel={t(
                    'session.diffLineRow.deleteNoteLabel',
                    'Delete note on line {{line}}',
                    {
                      line: comment.lineNumber
                    }
                  )}
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
        <MessageBox
          style={styles.diffCommentComposer}
          value={commentDraft}
          onChangeText={onDraftChange}
          placeholder={t('session.diffLineRow.notePlaceholder', 'Add review note')}
          editable={!commentsBusy}
          autoFocus
          onSend={() => {
            if (commentLine !== undefined) {
              onSubmitComment(commentLine)
            }
          }}
          canSend={commentDraft.trim().length > 0 && !commentsBusy}
          sendAccessibilityLabel={t('session.diffLineRow.saveNote', 'Save note')}
          leading={
            <Pressable
              style={({ pressed }) => [
                composerInputStyles.ghostButton,
                pressed && composerInputStyles.pressed
              ]}
              disabled={commentsBusy}
              onPress={onCancelComment}
              accessibilityRole="button"
              accessibilityLabel={t('common.cancel', 'Cancel')}
            >
              <X size={19} color={colors.textSecondary} strokeWidth={2} />
            </Pressable>
          }
        />
      ) : null}
    </View>
  )
}
