import { MobileFileMediaPreview } from '../files/MobileFileMediaPreview'
import type { MobileFilePreviewRpcSender } from '../files/mobile-file-preview-operations'
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  FlatList,
  View,
  Text,
  ScrollView,
  Pressable,
  Platform,
  type ListRenderItem
} from 'react-native'
import { Copy, MessageSquare, Send } from 'lucide-react-native'
import { MobileFileAddressToolbar } from '../components/MobileFileAddressToolbar'
import { MobileFilePreviewSourceText } from '../files/MobileFilePreviewSourceText'
import { useMobileLineNumbersPreference } from '../files/mobile-line-numbers-preference'
import {
  buildPlainMobileDiffSyntaxLines,
  highlightMobileDiffLines,
  resolveMobileSyntaxLanguage
} from './mobile-file-syntax'
import { MobileHtmlPreview } from '../components/MobileHtmlPreview'
import { MobilePanZoomImage } from '../components/MobilePanZoomImage'
import { MobileSvgPreview } from '../components/MobileSvgPreview'
import { colors, pressedStyle } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-session-styles'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type {
  DiffCommentActions,
  DiffSyntaxState,
  FileDocState,
  RenderableDiffLine
} from './mobile-session-route-types'
import { DiffLineRow } from './MobileSessionDiffLineRow'
import { sendableMobileDiffComments } from './mobile-diff-comments'
import { MobileLoadErrorState, MobileStateView } from '../components/MobileStateView'

import { scrollOffsetForPreviewLine } from '../files/mobile-file-preview-line-column'

export const MOBILE_SESSION_FILE_READER_LINE_HEIGHT = 19

export function scrollOffsetForSessionFileLine(line: number): number {
  return scrollOffsetForPreviewLine(line)
}

type FileReaderProps = {
  doc: FileDocState | undefined
  client?: MobileFilePreviewRpcSender | null
  title: string
  relativePath: string
  documentId?: string
  language?: string
  initialLine?: number
  initialLineSeq?: number
  diffCommentActions?: DiffCommentActions
}

export function FileReader(props: FileReaderProps) {
  return (
    <FileReaderDocument key={JSON.stringify([props.documentId, props.relativePath])} {...props} />
  )
}

function FileReaderDocument({
  doc,
  client = null,
  title,
  relativePath,
  language,
  initialLine,
  initialLineSeq,
  diffCommentActions
}: FileReaderProps) {
  const [showLineNumbers, setShowLineNumbers] = useMobileLineNumbersPreference()
  useMobileColorScheme()
  const t = useMobileTranslation()
  const syntaxLanguage = useMemo(
    () => resolveMobileSyntaxLanguage(relativePath || title, language),
    [language, relativePath, title]
  )
  const [diffSyntax, setDiffSyntax] = useState<DiffSyntaxState | null>(null)
  const [activeCommentLine, setActiveCommentLine] = useState<number | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const plainDiffLines = useMemo(
    () =>
      doc?.status === 'ready' && doc.kind === 'diff'
        ? buildPlainMobileDiffSyntaxLines(doc.lines)
        : [],
    [doc]
  )
  const diffCommentsForFile = useMemo(
    () =>
      diffCommentActions?.comments.filter(
        (comment) => comment.filePath === relativePath && comment.source !== 'markdown'
      ) ?? [],
    [diffCommentActions?.comments, relativePath]
  )
  const diffCommentsByLine = useMemo(() => {
    const map = new Map<number, DiffComment[]>()
    for (const comment of diffCommentsForFile) {
      const list = map.get(comment.lineNumber) ?? []
      list.push(comment)
      map.set(comment.lineNumber, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.createdAt - b.createdAt)
    }
    return map
  }, [diffCommentsForFile])

  const startComment = useCallback((lineNumber: number) => {
    setActiveCommentLine(lineNumber)
    setCommentDraft('')
  }, [])

  const cancelComment = useCallback(() => {
    setActiveCommentLine(null)
    setCommentDraft('')
  }, [])

  const submitComment = useCallback(
    (lineNumber: number) => {
      if (!diffCommentActions) {
        return
      }
      void diffCommentActions.onAdd(relativePath, lineNumber, commentDraft).then((added) => {
        if (added) {
          setActiveCommentLine(null)
          setCommentDraft('')
        }
      })
    },
    [commentDraft, diffCommentActions, relativePath]
  )

  const renderDiffLine: ListRenderItem<RenderableDiffLine> = useCallback(
    ({ item, index }) => (
      <DiffLineRow
        line={item}
        title={title}
        index={index}
        comments={
          item.newLineNumber !== undefined ? (diffCommentsByLine.get(item.newLineNumber) ?? []) : []
        }
        activeCommentLine={activeCommentLine}
        commentDraft={commentDraft}
        commentsBusy={diffCommentActions?.busy === true}
        onStartComment={startComment}
        onCancelComment={cancelComment}
        onDraftChange={setCommentDraft}
        onSubmitComment={submitComment}
        onDeleteComment={(commentId) => {
          if (diffCommentActions) {
            void diffCommentActions.onDelete(commentId)
          }
        }}
      />
    ),
    [
      activeCommentLine,
      cancelComment,
      commentDraft,
      diffCommentActions,
      diffCommentsByLine,
      startComment,
      submitComment,
      title
    ]
  )

  useEffect(() => {
    if (doc?.status !== 'ready' || doc.kind !== 'diff') {
      return undefined
    }

    // Defer highlighting one tick so large files appear as plain text immediately.
    const timer = setTimeout(() => {
      setDiffSyntax({
        doc,
        language: syntaxLanguage,
        lines: highlightMobileDiffLines(doc.lines, syntaxLanguage)
      })
    }, 0)

    return () => clearTimeout(timer)
  }, [doc, syntaxLanguage])

  if (!doc || doc.status === 'loading') {
    return <MobileStateView loading title={t('session.fileReader.loading', 'Loading file…')} />
  }
  if (doc.status === 'error') {
    return <MobileLoadErrorState error={doc.message} />
  }

  if (doc.kind === 'diff') {
    const activeDiffSyntax =
      diffSyntax?.doc === doc && diffSyntax.language === syntaxLanguage ? diffSyntax.lines : null
    const count = diffCommentActions?.comments.length ?? 0
    const unsentCommentCount = diffCommentActions
      ? sendableMobileDiffComments(
          diffCommentActions.comments,
          diffCommentActions.sendingCommentIds
        ).length
      : 0
    const commentsBusy = diffCommentActions?.busy === true
    const canCopyNotes = count > 0 && !commentsBusy
    const canSendNotes = unsentCommentCount > 0 && !commentsBusy
    return (
      <View style={styles.markdownEditor}>
        {diffCommentActions ? (
          <View style={styles.diffNotesToolbar}>
            <View style={styles.diffNotesTitleRow}>
              <MessageSquare size={14} color={colors.textSecondary} strokeWidth={2.2} />
              <Text style={styles.diffNotesTitle}>
                {count === 0
                  ? t('session.fileReader.noReviewNotes', 'No review notes')
                  : count === 1
                    ? t('session.fileReader.reviewNotes_one', '{{count}} review note', { count })
                    : t('session.fileReader.reviewNotes_other', '{{count}} review notes', {
                        count
                      })}
              </Text>
            </View>
            <View style={styles.diffNotesActions}>
              <Pressable
                style={({ pressed }) => [
                  styles.diffNotesActionButton,
                  !canCopyNotes && styles.diffCommentButtonDisabled,
                  pressed && pressedStyle
                ]}
                disabled={!canCopyNotes}
                onPress={() => void diffCommentActions.onCopyAll()}
                accessibilityLabel={t('session.fileReader.copyReviewNotes', 'Copy review notes')}
              >
                <Copy size={13} color={colors.textSecondary} strokeWidth={2.2} />
                <Text style={styles.diffNotesActionText}>{t('common.copy', 'Copy')}</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.diffNotesActionButton,
                  !canSendNotes && styles.diffCommentButtonDisabled,
                  pressed && pressedStyle
                ]}
                disabled={!canSendNotes}
                onPress={diffCommentActions.onSendAll}
                accessibilityLabel={t(
                  'session.fileReader.sendReviewNotes',
                  'Send review notes to AI'
                )}
              >
                <Send size={13} color={colors.textSecondary} strokeWidth={2.2} />
                <Text style={styles.diffNotesActionText}>
                  {t('session.fileReader.send', 'Send')}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        <FlatList
          data={activeDiffSyntax ?? plainDiffLines}
          style={styles.filePreviewScroll}
          contentContainerStyle={styles.filePreviewContent}
          keyExtractor={(line, index) =>
            `${index}:${line.kind}:${line.oldLineNumber ?? ''}:${line.newLineNumber ?? ''}`
          }
          renderItem={renderDiffLine}
          initialNumToRender={32}
          maxToRenderPerBatch={48}
          windowSize={7}
          removeClippedSubviews={Platform.OS !== 'web'}
          keyboardShouldPersistTaps="handled"
        />
      </View>
    )
  }

  if (doc.kind === 'media') {
    return <MobileFileMediaPreview media={doc.media} client={client} title={title} />
  }
  if (doc.kind === 'image') {
    return (
      <View style={styles.imagePreviewContainer}>
        <MobilePanZoomImage
          uri={doc.dataUri}
          label={t('session.fileReader.imageLabel', '{{title}} image', { title })}
        />
      </View>
    )
  }

  const renderSourceText = (content: string) => (
    <View
      style={styles.markdownEditor}
      accessibilityLabel={t('session.fileReader.previewLabel', '{{title}} preview', { title })}
    >
      <MobileFileAddressToolbar
        path={relativePath || title}
        showLineNumbers={showLineNumbers}
        onToggleLineNumbers={() => setShowLineNumbers((prev) => !prev)}
        content={content}
        truncated={doc.kind === 'file' ? doc.truncated : false}
        copyAccessibilityLabel="Copy file content"
      />
      <MobileFilePreviewSourceText
        relativePath={relativePath || title}
        content={content}
        truncated={doc.kind === 'file' ? doc.truncated : false}
        byteLength={doc.kind === 'file' ? doc.byteLength : content.length}
        initialLine={initialLine}
        initialLineSeq={initialLineSeq}
        showLineNumbers={showLineNumbers}
      />
    </View>
  )

  if (doc.kind === 'html') {
    return (
      <View style={styles.markdownEditor}>
        <MobileHtmlPreview html={doc.content} renderSource={() => renderSourceText(doc.content)} />
      </View>
    )
  }

  if (doc.kind === 'svg' && !doc.truncated) {
    return (
      <View style={styles.markdownEditor}>
        <MobileSvgPreview
          markup={doc.content}
          title={title}
          renderSource={() => renderSourceText(doc.content)}
        />
      </View>
    )
  }

  return renderSourceText(doc.content)
}
