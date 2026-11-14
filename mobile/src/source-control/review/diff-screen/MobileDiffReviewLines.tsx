import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FlatList,
  Platform,
  Pressable,
  Text,
  View,
  type HostInstance,
  type ViewStyle
} from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { UnfoldVertical } from 'lucide-react-native'
import type { DiffComment } from '../../../../../src/shared/diff-comment-types'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  DIFF_LINE_ID_PREFIX,
  MobileDiffReviewCharWidthProbe,
  MobileDiffReviewLine,
  mobileDiffReviewGutterWidth,
  mobileDiffReviewNumberWidth
} from './MobileDiffReviewLine'
import type { ReviewDiffLine } from '../diff-state/mobile-diff-review-screen-model'
import {
  buildMobileDiffReviewRows,
  type MobileDiffReviewRow
} from '../diff-state/mobile-diff-review-rows'
import { colors } from '../../../theme/mobile-theme'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'
import type { MobileDiffReviewThread } from '../diff-actions/mobile-diff-review-github'
import type { PRCommentCardActions } from '../pull-request/comments/PRCommentCard'
import { CommentGroupView } from '../pull-request/comments/PRCommentsSection'
import { useNow } from '../../../hooks/use-now'
import { triggerSelection } from '../../../platform/haptics/haptics'

const NO_OPENED_LINES: ReadonlySet<number> = new Set()

const RANGE_PICK_LONG_PRESS_MS = 350
const MAX_SCROLL_ATTEMPTS = 10
const NO_LINE_NOTES: readonly DiffComment[] = []
const SCROLL_RETRY_MS = 100
// The page's default tab-size, so a tabbed line's width matches what it draws.
const TAB_COLUMNS = 8
const CODE_END_PADDING = 10
const NOTES_WIDTH = 40

function lineColumns(text: string): number {
  let columns = 0
  for (const char of text) {
    columns = char === '\t' ? (Math.floor(columns / TAB_COLUMNS) + 1) * TAB_COLUMNS : columns + 1
  }
  return columns
}

export type LineRange = { startLine: number; line: number }

// Keyed by file, so folds the reader opened close again on the next file.
export function MobileDiffReviewLines({
  lines,
  truncated,
  commentsByLine,
  staleCommentIds,
  threadsByLine,
  threadActions,
  selectedRange,
  scrollToLine,
  onScrolledToLine,
  onPickLines,
  onEditNote
}: {
  lines: ReviewDiffLine[]
  truncated: boolean
  commentsByLine: ReadonlyMap<number, DiffComment[]>
  staleCommentIds: ReadonlySet<string>
  threadsByLine: ReadonlyMap<number, readonly MobileDiffReviewThread[]>
  threadActions: PRCommentCardActions | undefined
  /** The lines the open note sheet is about, kept highlighted under it. */
  selectedRange: LineRange | null
  scrollToLine: number | null
  onScrolledToLine: () => void
  /** Absent where lines take no notes, e.g. a past commit's files. */
  onPickLines?: (range: LineRange) => void
  onEditNote: (comment: DiffComment) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const now = useNow(60_000, threadsByLine.size > 0)
  // Opened folds are line indexes into this load; a reload with new lines starts folded again.
  const [opened, setOpened] = useState<{ lines: ReviewDiffLine[]; indexes: ReadonlySet<number> }>(
    () => ({ lines, indexes: new Set() })
  )
  const openedLines = opened.lines === lines ? opened.indexes : NO_OPENED_LINES
  const rows = useMemo(
    () =>
      buildMobileDiffReviewRows(lines, openedLines, new Set(commentsByLine.keys()), threadsByLine),
    [commentsByLine, lines, openedLines, threadsByLine]
  )
  const openFold = (startIndex: number, endIndex: number) => {
    const next = new Set(openedLines)
    for (let index = startIndex; index < endIndex; index += 1) {
      next.add(index)
    }
    setOpened({ lines, indexes: next })
  }

  // Long lines run on one line and the whole file scrolls sideways, so every row is as wide as the longest.
  const [charWidth, setCharWidth] = useState(0)
  const [viewportWidth, setViewportWidth] = useState(0)
  const { numberWidth, codeColumns } = useMemo(() => {
    let digits = 1
    let columns = 0
    for (const line of lines) {
      digits = Math.max(digits, String(line.newLineNumber ?? line.oldLineNumber ?? '').length)
      columns = Math.max(columns, lineColumns(line.text))
    }
    return { numberWidth: mobileDiffReviewNumberWidth(digits, charWidth), codeColumns: columns }
  }, [charWidth, lines])
  const gutterWidth = mobileDiffReviewGutterWidth(numberWidth)
  const rowFrame: ViewStyle =
    Platform.OS === 'web' && charWidth > 0
      ? {
          width: Math.max(
            viewportWidth,
            Math.ceil(
              gutterWidth +
                codeColumns * charWidth +
                CODE_END_PADDING +
                (commentsByLine.size > 0 ? NOTES_WIDTH : 0)
            )
          )
        }
      : {}
  // Folds, threads and the footer hold still in the viewport while the code slides under them.
  const viewportRow: ViewStyle =
    Platform.OS === 'web' && viewportWidth > 0
      ? {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RN Web renders CSS sticky; this branch never reaches native.
          position: 'sticky' as ViewStyle['position'],
          left: 0,
          width: viewportWidth
        }
      : {}

  const listRef = useRef<FlatList<MobileDiffReviewRow<ReviewDiffLine>>>(null)
  const scrollFailedRef = useRef(false)
  const [scrollAttempt, setScrollAttempt] = useState(0)
  useEffect(() => {
    if (scrollToLine === null) {
      return
    }
    const index = rows.findIndex(
      (row) =>
        row.kind === 'line' && row.line.kind !== 'delete' && row.line.newLineNumber === scrollToLine
    )
    if (index !== -1) {
      // An unmeasured row can't be scrolled to yet: jump near it, let it lay out, and try again.
      scrollFailedRef.current = false
      listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.3 })
      if (!scrollFailedRef.current || scrollAttempt >= MAX_SCROLL_ATTEMPTS) {
        onScrolledToLine()
        return
      }
      const retry = setTimeout(() => setScrollAttempt((attempt) => attempt + 1), SCROLL_RETRY_MS)
      return () => clearTimeout(retry)
    }
    // A target inside folded context opens its fold first; the next rows then have it.
    const lineIndex = lines.findIndex(
      (line) => line.kind !== 'delete' && line.newLineNumber === scrollToLine
    )
    const fold = rows.find(
      (row) => row.kind === 'fold' && lineIndex >= row.startIndex && lineIndex < row.endIndex
    )
    if (fold?.kind === 'fold') {
      openFold(fold.startIndex, fold.endIndex)
    } else {
      onScrolledToLine()
    }
  }, [lines, onScrolledToLine, rows, scrollAttempt, scrollToLine])

  // Long-press then drag picks lines. The screen only renders as the page (the native route mounts the web shell),
  // so the row under the finger comes from the document: no cached layout can go stale as folds and threads move rows.
  const [dragRange, setDragRange] = useState<{ anchor: number; line: number } | null>(null)
  // The gesture's own copy, read when it ends; the state only paints the highlight.
  const dragRangeRef = useRef<{ anchor: number; line: number } | null>(null)
  // The release that ends a pick also reaches the starting row as a tap; that tap must not replace the range.
  const pickConsumedTapRef = useRef(false)
  // Browsers decide on the first touchmove whether to scroll; once a pick is live, claim it so the drag isn't cancelled.
  const frameRef = useRef<HostInstance>(null)
  useEffect(() => {
    const node: unknown = frameRef.current
    if (Platform.OS !== 'web' || !(node instanceof EventTarget)) {
      return
    }
    const holdTouch = (event: Event) => {
      if (dragRangeRef.current) {
        event.preventDefault()
      }
    }
    node.addEventListener('touchmove', holdTouch, { passive: false })
    return () => node.removeEventListener('touchmove', holdTouch)
  }, [])
  const updateDragRange = (next: { anchor: number; line: number } | null) => {
    dragRangeRef.current = next
    setDragRange(next)
  }
  const lineAt = (x: number, y: number): number | null => {
    if (typeof document === 'undefined') {
      return null
    }
    const row = document.elementFromPoint(x, y)?.closest(`[id^="${DIFF_LINE_ID_PREFIX}"]`)
    const line = row ? Number(row.id.slice(DIFF_LINE_ID_PREFIX.length)) : Number.NaN
    return Number.isInteger(line) ? line : null
  }
  const pick = Gesture.Pan()
    .enabled(onPickLines !== undefined)
    .activateAfterLongPress(RANGE_PICK_LONG_PRESS_MS)
    .shouldCancelWhenOutside(false)
    .runOnJS(true)
    // A new touch starts fresh, so a pick whose release sent no tap can't swallow the next real one.
    .onBegin(() => {
      pickConsumedTapRef.current = false
    })
    .onStart((event) => {
      const line = lineAt(event.absoluteX, event.absoluteY)
      if (line !== null) {
        triggerSelection()
        updateDragRange({ anchor: line, line })
      }
    })
    .onUpdate((event) => {
      const line = lineAt(event.absoluteX, event.absoluteY)
      const prev = dragRangeRef.current
      if (line !== null && prev && prev.line !== line) {
        updateDragRange({ ...prev, line })
      }
    })
    .onFinalize((_event, success) => {
      const picked = dragRangeRef.current
      updateDragRange(null)
      if (picked) {
        pickConsumedTapRef.current = true
      }
      // A cancelled drag (the browser took the touch, say) picks nothing.
      if (picked && success) {
        onPickLines?.({
          startLine: Math.min(picked.anchor, picked.line),
          line: Math.max(picked.anchor, picked.line)
        })
      }
    })
  // Stable, so a drag step re-renders only the rows whose highlight changed.
  const pickOneLine = useCallback(
    (line: number) => {
      if (pickConsumedTapRef.current) {
        pickConsumedTapRef.current = false
        return
      }
      onPickLines?.({ startLine: line, line })
    },
    [onPickLines]
  )
  const highlighted: LineRange | null = dragRange
    ? {
        startLine: Math.min(dragRange.anchor, dragRange.line),
        line: Math.max(dragRange.anchor, dragRange.line)
      }
    : selectedRange

  return (
    <GestureDetector gesture={pick}>
      <View
        ref={frameRef}
        style={styles.diffListFrame}
        onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)}
      >
        <MobileDiffReviewCharWidthProbe onCharWidth={setCharWidth} />
        <FlatList<MobileDiffReviewRow<ReviewDiffLine>>
          ref={listRef}
          data={rows}
          style={styles.diffList}
          // The list holds still while lines are being picked, so the drag selects instead of scrolling.
          scrollEnabled={dragRange === null}
          onScrollToIndexFailed={(info) => {
            scrollFailedRef.current = true
            listRef.current?.scrollToOffset({
              offset: Math.max(0, info.averageItemLength * info.index),
              animated: false
            })
          }}
          keyExtractor={(row) => row.key}
          renderItem={({ item: row }) => (
            <View style={rowFrame}>
              {row.kind === 'fold' ? (
                <Pressable
                  style={({ pressed }) => [
                    styles.foldRow,
                    viewportRow,
                    pressed && styles.buttonPressed
                  ]}
                  onPress={() => openFold(row.startIndex, row.endIndex)}
                  accessibilityRole="button"
                  accessibilityLabel={t(
                    'components.diffReviewBody.showUnchangedLines',
                    'Show {{count}} unchanged lines',
                    { count: row.hiddenCount }
                  )}
                >
                  <View style={[styles.foldIcon, { width: gutterWidth }]}>
                    <UnfoldVertical size={14} color={colors.diffFoldText} strokeWidth={2} />
                  </View>
                  <View style={styles.foldBody}>
                    <Text style={styles.foldText}>
                      {row.hiddenCount === 1
                        ? t(
                            'components.diffReviewBody.unchangedLines_one',
                            '{{count}} unchanged line',
                            {
                              count: row.hiddenCount
                            }
                          )
                        : t(
                            'components.diffReviewBody.unchangedLines_other',
                            '{{count}} unchanged lines',
                            { count: row.hiddenCount }
                          )}
                    </Text>
                    {row.enclosingLine ? (
                      <Text style={styles.foldContext} numberOfLines={1}>
                        {row.enclosingLine}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              ) : row.kind === 'thread' ? (
                <View style={[styles.threadRow, viewportRow]}>
                  <CommentGroupView group={row.thread} actions={threadActions} now={now} />
                </View>
              ) : (
                <MobileDiffReviewLine
                  line={row.line}
                  comments={commentsByLine.get(row.line.newLineNumber ?? -1) ?? NO_LINE_NOTES}
                  staleCommentIds={staleCommentIds}
                  numberWidth={numberWidth}
                  selected={
                    highlighted !== null &&
                    row.line.kind !== 'delete' &&
                    row.line.newLineNumber !== undefined &&
                    row.line.newLineNumber >= highlighted.startLine &&
                    row.line.newLineNumber <= highlighted.line
                  }
                  {...(onPickLines ? { onAddNote: pickOneLine } : {})}
                  onEditNote={onEditNote}
                />
              )}
            </View>
          )}
          contentContainerStyle={styles.diffListContent}
          ListFooterComponentStyle={rowFrame}
          ListFooterComponent={
            truncated ? (
              <Text style={[styles.truncatedText, viewportRow]}>
                {t('components.diffReviewBody.diffTruncated', 'Diff truncated for mobile preview.')}
              </Text>
            ) : undefined
          }
        />
      </View>
    </GestureDetector>
  )
}
