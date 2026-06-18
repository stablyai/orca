import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Animated, AppState, Linking, type AppStateStatus } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import {
  BackHandler,
  FlatList,
  Image,
  View,
  Text,
  ScrollView,
  TextInput,
  Pressable,
  Keyboard,
  Platform,
  ActivityIndicator,
  type KeyboardEvent,
  type LayoutChangeEvent,
  type ListRenderItem
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  AlertTriangle,
  ArrowUp,
  Bot,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  Copy,
  Eraser,
  Folder,
  File,
  FileText,
  GitBranch,
  Globe,
  ImagePlus,
  Keyboard as KeyboardIcon,
  ListChecks,
  MessageSquare,
  Mic,
  Monitor,
  Plus,
  RefreshCw,
  Send,
  Smartphone,
  SquareTerminal,
  X
} from 'lucide-react-native'
import type { RpcClient } from '../../../../src/transport/rpc-client'
import type { RuntimeTerminalPathResolution } from '../../../../../src/shared/runtime-types'
import { loadHosts } from '../../../../src/transport/host-store'
import {
  loadTerminalAutocompleteEnabled,
  loadTerminalLinkOpenMode,
  loadTerminalTextScale,
  HOST_DOCK_MIN_WIDTH,
  saveTerminalTextScale,
  type MobileTerminalLinkOpenMode
} from '../../../../src/storage/preferences'
import {
  useHostClient,
  useForceReconnect,
  useReconnectAttempt,
  useLastConnectedAt
} from '../../../../src/transport/client-context'
import { classifyConnection } from '../../../../src/transport/connection-health'
import { useResponsiveLayout } from '../../../../src/layout/responsive-layout'
import {
  type ActivePanel,
  canDockSessionPanel,
  resolvePanelAction,
  panelRouteDescriptor
} from '../../../../src/session/session-panel-host'
import { useMobilePrBranchContext } from '../../../../src/session/use-mobile-pr-branch-context'
import { SessionDockColumn } from '../../../../src/session/SessionDockColumn'
import type { ConnectionState, RpcFailure, RpcSuccess } from '../../../../src/transport/types'
import { useMobileDictation } from '../../../../src/hooks/use-mobile-dictation'
import {
  triggerMediumImpact,
  triggerSelection,
  triggerSuccess,
  triggerError,
  triggerEdgeBump
} from '../../../../src/platform/haptics'
import {
  type TerminalKeyboardAvoidanceMetrics,
  type TerminalModes,
  type TerminalWebViewHandle
} from '../../../../src/terminal/TerminalWebView'
import { useTerminalViewportRefit } from '../../../../src/terminal/terminal-viewport-refit'
import {
  getDefaultTerminalAccessoryBuiltInIds,
  getVisibleTerminalAccessoryKeys,
  loadTerminalAccessoryLayout
} from '../../../../src/terminal/terminal-accessory-layout'
import {
  clearTerminalLiveInputFocusTimer,
  getTerminalLiveSpecialKeyBytes,
  isTerminalLiveInputWithinByteLimit,
  scheduleTerminalLiveInputFocus
} from '../../../../src/terminal/terminal-live-input'
import { normalizeTerminalTextInput } from '../../../../src/terminal/terminal-text-input-normalization'
import { countTerminalGestureInputSequences } from '../../../../src/terminal/terminal-gesture-input'
import { MobileBrowserPane } from '../../../../src/browser/MobileBrowserPane'
import { isBlankBrowserUrl, normalizeBrowserUrl } from '../../../../src/browser/browser-url'
import { StatusDot } from '../../../../src/components/StatusDot'
import { ActionSheetModal } from '../../../../src/components/ActionSheetModal'
import { MobileAgentIcon } from '../../../../src/components/MobileAgentIcon'
import { TextInputModal } from '../../../../src/components/TextInputModal'
import { ConfirmModal } from '../../../../src/components/ConfirmModal'
import { MobileRichMarkdownEditor } from '../../../../src/components/MobileRichMarkdownEditor'
import { MobileSyntaxSegments } from '../../../../src/components/MobileSyntaxSegments'
import {
  CustomKeyModal,
  loadCustomKeys,
  saveCustomKeys,
  type CustomKey
} from '../../../../src/components/CustomKeyModal'
import { buildMobileDiffLines } from '../../../../src/session/mobile-diff-lines'
import {
  addMobileDiffComment,
  formatDiffComments,
  normalizeMobileDiffComments,
  removeDeliveredMobileDiffComments,
  removeMobileDiffComments
} from '../../../../src/session/mobile-diff-comments'
import {
  buildPlainMobileDiffSyntaxLines,
  highlightMobileCode,
  highlightMobileDiffLines,
  resolveMobileSyntaxLanguage
} from '../../../../src/session/mobile-file-syntax'
import {
  getTerminalRecordsFromSessionTabs,
  mergeTerminalListWithKnownRecords,
  mergeTerminalRecordsByCurrentOrder,
  mobileSessionTabsEqual,
  terminalRecordsEqual
} from '../../../../src/session/mobile-terminal-records'
import {
  buildMobileNewTabAgentOptions,
  type MobileNewTabAgentOption,
  type MobileNewTabAgentSettings
} from '../../../../src/session/mobile-new-tab-agent-options'
import {
  buildMobileImagePastePayload,
  saveMobileClipboardImageAsTempFile
} from '../../../../src/session/mobile-clipboard-image'
import { useMobileImageAttachment } from '../../../../src/session/use-mobile-image-attachment'
import { classifyMobileArtifact } from '../../../../src/session/mobile-artifact-kind'
import {
  buildMarkdownDiskFallbackDoc,
  shouldReadMarkdownFromDiskAfterReadTabFailure
} from '../../../../src/session/mobile-markdown-disk-fallback'
import { MobileHtmlPreview } from '../../../../src/components/MobileHtmlPreview'
import { MobileDictationSetupSheet } from '../../../../src/components/MobileDictationSetupSheet'
import {
  fetchDictationSetup,
  isDictationSetupRequiredError
} from '../../../../src/dictation/mobile-dictation-setup'
import { TerminalPaneView } from '../../../../src/session/TerminalPaneView'
import {
  getRepoIdFromMobileWorktreeId,
  isFileExistsErrorMessage,
  isGestureMouseTrackingMode,
  MOBILE_SESSION_STATUS_LABELS,
  TERMINAL_GESTURE_INPUT_BUCKET_CAPACITY,
  TERMINAL_GESTURE_INPUT_FLUSH_DELAY_MS,
  TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES,
  TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS,
  TERMINAL_GESTURE_INPUT_REFILL_PER_SECOND
} from '../../../../src/session/mobile-session-route-helpers'
import { resolveMarkdownFloatingActionsBottom } from '../../../../src/session/markdown-floating-actions-layout'
import { resolveTabStripScrollOffset } from '../../../../src/session/tab-strip-scroll'
import {
  createMobileSessionCreateWarningState,
  dismissMobileSessionCreateWarningState,
  reconcileMobileSessionCreateWarningState
} from '../../../../src/session/mobile-session-create-warning-state'
import { colors, spacing } from '../../../../src/theme/mobile-theme'
import { styles } from './mobile-session-styles'
import type { DiffComment } from '../../../../../src/shared/types'
import type {
  DiffCommentActions,
  DiffNotesDelivery,
  DiffSyntaxState,
  DirtyMarkdownDraft,
  FileDocState,
  FileSyntaxState,
  MarkdownDocState,
  MobileDisplayMode,
  MobileNewTabAgentLoadState,
  MobileSessionTab,
  MobileSessionTabType,
  RenderableDiffLine,
  RuntimeRepoSummary,
  RuntimeStatusResult,
  SessionTabsResult,
  Terminal,
  TerminalCreateResult,
  TerminalGestureInputBucket,
  TerminalGestureInputQueue
} from './mobile-session-route-types'

function getActiveTabIdForHandle(
  tabs: MobileSessionTab[],
  terminalHandle: string | null
): string | null {
  if (!terminalHandle) {
    return null
  }
  return (
    tabs.find(
      (tab): tab is Extract<MobileSessionTab, { type: 'terminal' }> =>
        tab.type === 'terminal' && tab.terminal === terminalHandle
    )?.id ?? terminalHandle
  )
}

function getMobileSessionTabTitle(tab: MobileSessionTab): string {
  if (tab.type === 'browser') {
    const title = tab.title.trim()
    if (title && !isBlankBrowserUrl(title)) {
      return title
    }
    if (isBlankBrowserUrl(tab.url)) {
      return 'New Browser'
    }
    return 'Browser'
  }
  if (tab.type === 'markdown') {
    return tab.title || 'Markdown'
  }
  if (tab.type === 'file') {
    return tab.title || 'File'
  }
  return tab.title || 'Terminal'
}

function MarkdownReader({
  documentId,
  doc,
  onRefresh,
  onChange,
  onSave,
  onCopy,
  onDiscard,
  keyboardLift
}: {
  documentId: string
  doc: MarkdownDocState | undefined
  onRefresh: () => void
  onChange: (content: string) => void
  onSave: () => void
  onCopy: () => void
  onDiscard: () => void
  keyboardLift: number
}) {
  // The editor lives in a WebView; native Keyboard events under-report its
  // covered area, so prefer the inset measured inside the WebView when larger.
  const [webviewKeyboardInset, setWebviewKeyboardInset] = useState(0)
  const effectiveKeyboardLift = Math.max(keyboardLift, webviewKeyboardInset)
  if (!doc || doc.status === 'loading') {
    return (
      <View style={styles.markdownState}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
      </View>
    )
  }
  if (doc.status === 'error') {
    return (
      <View style={styles.markdownState}>
        <Text style={styles.markdownError}>{doc.message}</Text>
        <Pressable style={styles.markdownRefreshButton} onPress={onRefresh}>
          <RefreshCw size={14} color={colors.textPrimary} />
          <Text style={styles.markdownRefreshText}>Retry</Text>
        </Pressable>
      </View>
    )
  }

  const statusText = doc.saveError
    ? doc.saveError
    : doc.readOnlyReason
      ? 'Read only'
      : doc.stale
        ? 'Changed on desktop'
        : null
  const showRefresh = (doc.stale && !doc.isDirty) || !doc.editable
  const showCopy = doc.saveError || !doc.editable
  const showSave = doc.isDirty || doc.saving
  const showFloatingActions = statusText || showRefresh || showCopy || showSave

  return (
    <View style={styles.markdownEditor}>
      <MobileRichMarkdownEditor
        key={documentId}
        content={doc.localContent}
        editable={doc.editable && !doc.saving}
        onChange={onChange}
        onKeyboardInsetChange={setWebviewKeyboardInset}
      />
      {showFloatingActions ? (
        <View
          pointerEvents="box-none"
          style={[
            styles.markdownFloatingBar,
            // Why: the editor focus lives inside a WebView, so keep native
            // Save/Discard controls lifted instead of resizing that surface.
            {
              bottom: resolveMarkdownFloatingActionsBottom({
                keyboardLift: effectiveKeyboardLift,
                restingBottom: spacing.lg,
                liftedClearance: spacing.md
              })
            }
          ]}
        >
          {statusText ? (
            <Text
              style={[styles.markdownFloatingStatus, doc.saveError ? styles.markdownError : null]}
              numberOfLines={2}
            >
              {statusText}
            </Text>
          ) : null}
          <View style={styles.markdownFloatingActions}>
            {showCopy ? (
              <Pressable style={styles.markdownFloatingButton} onPress={onCopy}>
                <Text style={styles.markdownFloatingButtonText}>Copy</Text>
              </Pressable>
            ) : null}
            {showRefresh ? (
              <Pressable style={styles.markdownFloatingButton} onPress={onRefresh}>
                <RefreshCw size={13} color={colors.textPrimary} />
                <Text style={styles.markdownFloatingButtonText}>Refresh</Text>
              </Pressable>
            ) : null}
            {doc.isDirty ? (
              <Pressable style={styles.markdownFloatingButton} onPress={onDiscard}>
                <Text style={styles.markdownFloatingButtonText}>Discard</Text>
              </Pressable>
            ) : null}
            {showSave ? (
              <Pressable
                style={[
                  styles.markdownFloatingButton,
                  styles.markdownSaveButton,
                  (!doc.editable || !doc.isDirty || doc.saving) && styles.markdownButtonDisabled
                ]}
                disabled={!doc.editable || !doc.isDirty || doc.saving}
                onPress={onSave}
              >
                {doc.saving ? (
                  <ActivityIndicator size="small" color={colors.textPrimary} />
                ) : (
                  <Text style={styles.markdownFloatingButtonText}>Save</Text>
                )}
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  )
}

function DiffLineRow({
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
  // Why: review notes are anchored to the modified side, so the single mobile
  // gutter should show the same line number the note will reference.
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

function FileReader({
  doc,
  title,
  relativePath,
  language,
  diffCommentActions
}: {
  doc: FileDocState | undefined
  title: string
  relativePath: string
  language?: string
  diffCommentActions?: DiffCommentActions
}) {
  const syntaxLanguage = useMemo(
    () => resolveMobileSyntaxLanguage(relativePath || title, language),
    [language, relativePath, title]
  )
  const [fileSyntax, setFileSyntax] = useState<FileSyntaxState | null>(null)
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
    if (doc?.status !== 'ready') {
      return undefined
    }

    // Why: highlighting can create many nested Text nodes; defer it one tick so
    // large files show immediately as plain text before colors are applied.
    const timer = setTimeout(() => {
      // file + html share the syntax-segment source view (html's "Source" toggle).
      if (doc.kind === 'file' || doc.kind === 'html') {
        setFileSyntax({
          doc,
          language: syntaxLanguage,
          segments: highlightMobileCode(doc.content, syntaxLanguage).segments
        })
        return
      }
      if (doc.kind === 'diff') {
        setDiffSyntax({
          doc,
          language: syntaxLanguage,
          lines: highlightMobileDiffLines(doc.lines, syntaxLanguage)
        })
      }
      // image: no syntax highlighting.
    }, 0)

    return () => clearTimeout(timer)
  }, [doc, syntaxLanguage])

  if (!doc || doc.status === 'loading') {
    return (
      <View style={styles.markdownState}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
      </View>
    )
  }
  if (doc.status === 'error') {
    return (
      <View style={styles.markdownState}>
        <Text style={styles.markdownError}>{doc.message}</Text>
      </View>
    )
  }

  if (doc.kind === 'diff') {
    const activeDiffSyntax =
      diffSyntax?.doc === doc && diffSyntax.language === syntaxLanguage ? diffSyntax.lines : null
    const commentCount = diffCommentActions?.comments.length ?? 0
    const unsentCommentCount =
      diffCommentActions?.comments.filter((comment) => !comment.sentAt).length ?? 0
    const commentsBusy = diffCommentActions?.busy === true
    const canCopyNotes = commentCount > 0 && !commentsBusy
    const canSendNotes = unsentCommentCount > 0 && !commentsBusy
    return (
      <View style={styles.markdownEditor}>
        {diffCommentActions ? (
          <View style={styles.diffNotesToolbar}>
            <View style={styles.diffNotesTitleRow}>
              <MessageSquare size={14} color={colors.textSecondary} strokeWidth={2.2} />
              <Text style={styles.diffNotesTitle}>
                {commentCount === 0
                  ? 'No review notes'
                  : `${commentCount} review ${commentCount === 1 ? 'note' : 'notes'}`}
              </Text>
            </View>
            <View style={styles.diffNotesActions}>
              <Pressable
                style={[
                  styles.diffNotesActionButton,
                  !canCopyNotes && styles.diffCommentButtonDisabled
                ]}
                disabled={!canCopyNotes}
                onPress={() => void diffCommentActions.onCopyAll()}
                accessibilityLabel="Copy review notes"
              >
                <Copy size={13} color={colors.textSecondary} strokeWidth={2.2} />
                <Text style={styles.diffNotesActionText}>Copy</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.diffNotesActionButton,
                  !canSendNotes && styles.diffCommentButtonDisabled
                ]}
                disabled={!canSendNotes}
                onPress={diffCommentActions.onSendAll}
                accessibilityLabel="Send review notes to AI"
              >
                <Send size={13} color={colors.textSecondary} strokeWidth={2.2} />
                <Text style={styles.diffNotesActionText}>Send</Text>
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

  if (doc.kind === 'image') {
    return (
      <View style={styles.imagePreviewContainer}>
        <ScrollView
          style={styles.imagePreviewScroll}
          contentContainerStyle={styles.imagePreviewContent}
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
        >
          <Image
            source={{ uri: doc.dataUri }}
            style={styles.imagePreview}
            resizeMode="contain"
            accessibilityLabel={`${title} image`}
          />
        </ScrollView>
      </View>
    )
  }

  const renderSourceText = (content: string) => (
    <View style={styles.markdownEditor}>
      <ScrollView
        style={styles.filePreviewScroll}
        contentContainerStyle={styles.filePreviewContent}
      >
        <Text selectable style={styles.filePreviewText} accessibilityLabel={`${title} preview`}>
          <MobileSyntaxSegments
            segments={
              fileSyntax?.doc === doc && fileSyntax.language === syntaxLanguage
                ? fileSyntax.segments
                : [{ text: content, kind: 'plain' }]
            }
          />
        </Text>
      </ScrollView>
    </View>
  )

  if (doc.kind === 'html') {
    return (
      <View style={styles.markdownEditor}>
        <MobileHtmlPreview html={doc.content} renderSource={() => renderSourceText(doc.content)} />
      </View>
    )
  }

  return renderSourceText(doc.content)
}

export default function SessionScreen() {
  const {
    hostId,
    worktreeId,
    name: worktreeName,
    created,
    warning: createdWarning
  } = useLocalSearchParams<{
    hostId: string
    worktreeId: string
    name?: string
    created?: string
    warning?: string
  }>()
  const isFolderWorkspaceRoute = worktreeId.startsWith('folder:')
  const router = useRouter()
  const insets = useSafeAreaInsets()
  // Why: shared client per host owned by RpcClientProvider. See
  // docs/mobile-shared-client-per-host.md.
  const { client, state: connState } = useHostClient(hostId)
  const reconnectAttempts = useReconnectAttempt(hostId)
  const lastConnectedAt = useLastConnectedAt(hostId)
  const forceReconnectHost = useForceReconnect()
  // Master-detail host state (U5/KTD2): on wide layouts a tapped panel docks beside the
  // session content; on narrow it stays null and the icons push full-screen routes.
  const { isWideLayout } = useResponsiveLayout()
  const [activePanel, setActivePanel] = useState<ActivePanel>(null)
  const [sessionContentRowWidth, setSessionContentRowWidth] = useState(0)
  const canDockPanel = canDockSessionPanel({
    isWideLayout,
    availableWidth: sessionContentRowWidth,
    dockWidth: HOST_DOCK_MIN_WIDTH
  })
  // Why: docking needs enough measured row width. If rotation/split-screen makes
  // the session row too narrow while a panel is docked, clear activePanel so the
  // icon state and live mounted panel do not survive into overlay/push mode.
  useEffect(() => {
    if (!canDockPanel && activePanel !== null) {
      setActivePanel(null)
    }
  }, [canDockPanel, activePanel])
  // Session-level PR context feeds the docked PR panel and gates the GitHub-only
  // PR entry so GitLab/other providers do not open a GitHub RPC surface.
  const {
    branch: prBranch,
    headSha: prHeadSha,
    isGithubRepo: prIsGithubRepo,
    repoLoaded: prRepoContextLoaded,
    loaded: prContextLoaded
  } = useMobilePrBranchContext({
    client,
    connState,
    worktreeId
  })
  useEffect(() => {
    if (prRepoContextLoaded && !prIsGithubRepo && activePanel === 'pr') {
      setActivePanel(null)
    }
  }, [activePanel, prRepoContextLoaded, prIsGithubRepo])
  const initialCreateWarning = typeof createdWarning === 'string' ? createdWarning.trim() : ''
  const [terminals, setTerminals] = useState<Terminal[]>([])
  const terminalsRef = useRef<Terminal[]>([])
  const [sessionTabs, setSessionTabs] = useState<MobileSessionTab[]>([])
  const sessionTabsRef = useRef<MobileSessionTab[]>([])
  const [terminalsLoaded, setTerminalsLoaded] = useState(false)
  const [input, setInput] = useState('')
  // Why: baseline terminal zoom, reloaded on focus so a Settings → Terminal change
  // applies in place (the terminal panes stay mounted).
  const [terminalTextScale, setTerminalTextScale] = useState(1)
  // Why: local opt-in for keyboard autocomplete/autocorrect on the terminal
  // command bar; reloaded on focus so a Settings → Terminal toggle takes effect on return.
  const [autocompleteEnabled, setAutocompleteEnabled] = useState(false)
  const [terminalLinkOpenMode, setTerminalLinkOpenMode] =
    useState<MobileTerminalLinkOpenMode>('orca-browser')
  const [liveInputCapture, setLiveInputCapture] = useState('')
  const [liveInputTerminalHandles, setLiveInputTerminalHandles] = useState<Set<string>>(
    () => new Set()
  )
  const [activeHandle, setActiveHandle] = useState<string | null>(null)
  const [activeSessionTabId, setActiveSessionTabId] = useState<string | null>(null)
  const activeSessionTabIdRef = useRef<string | null>(null)
  // Auto-scroll the tab strip so the active tab (synced from desktop on
  // worktree entry) is revealed without a manual scroll.
  const tabStripRef = useRef<ScrollView>(null)
  const tabStripOffsetRef = useRef(0)
  const tabStripViewportWidthRef = useRef(0)
  const tabStripContentWidthRef = useRef(0)
  const tabLayoutsRef = useRef<Map<string, { x: number; width: number }>>(new Map())
  const [markdownDocs, setMarkdownDocs] = useState<Map<string, MarkdownDocState>>(new Map())
  const markdownDocsRef = useRef<Map<string, MarkdownDocState>>(new Map())
  const [fileDocs, setFileDocs] = useState<Map<string, FileDocState>>(new Map())
  const [diffComments, setDiffComments] = useState<DiffComment[]>([])
  const diffCommentsRef = useRef<DiffComment[]>([])
  const [diffCommentBusy, setDiffCommentBusy] = useState(false)
  const [pendingDiffNotesDelivery, setPendingDiffNotesDelivery] =
    useState<DiffNotesDelivery | null>(null)
  const [creating, setCreating] = useState(false)
  const [creatingBrowser, setCreatingBrowser] = useState(false)
  const [creatingMarkdown, setCreatingMarkdown] = useState(false)
  const [createError, setCreateError] = useState('')
  const [createWarningState, setCreateWarningState] = useState(() =>
    createMobileSessionCreateWarningState(initialCreateWarning)
  )
  const [showCreateTabDrawer, setShowCreateTabDrawer] = useState(false)
  const [createTabAgentLoadState, setCreateTabAgentLoadState] =
    useState<MobileNewTabAgentLoadState>('idle')
  const [createTabAgentOptions, setCreateTabAgentOptions] = useState<MobileNewTabAgentOption[]>([])
  const [showCreateBrowserModal, setShowCreateBrowserModal] = useState(false)
  const [actionTarget, setActionTarget] = useState<Terminal | null>(null)
  const [markdownActionTarget, setMarkdownActionTarget] = useState<Extract<
    MobileSessionTab,
    { type: 'markdown' }
  > | null>(null)
  const [fileActionTarget, setFileActionTarget] = useState<Extract<
    MobileSessionTab,
    { type: 'file' }
  > | null>(null)
  const [browserActionTarget, setBrowserActionTarget] = useState<Extract<
    MobileSessionTab,
    { type: 'browser' }
  > | null>(null)
  const [discardMarkdownTarget, setDiscardMarkdownTarget] = useState<Extract<
    MobileSessionTab,
    { type: 'markdown' }
  > | null>(null)
  const [leaveDrafts, setLeaveDrafts] = useState<DirtyMarkdownDraft[] | null>(null)
  const [renameTarget, setRenameTarget] = useState<Terminal | null>(null)
  const [customKeys, setCustomKeys] = useState<CustomKey[]>([])
  const [visibleBuiltInIds, setVisibleBuiltInIds] = useState<string[]>(
    getDefaultTerminalAccessoryBuiltInIds
  )
  const [showCustomKeyModal, setShowCustomKeyModal] = useState(false)
  const [deleteKeyTarget, setDeleteKeyTarget] = useState<CustomKey | null>(null)
  const visibleBuiltInAccessoryKeys = useMemo(
    () => getVisibleTerminalAccessoryKeys(visibleBuiltInIds),
    [visibleBuiltInIds]
  )
  // Why: in Expo SDK 55 edge-to-edge mode the OS does NOT resize the window when
  // the IME opens — the keyboard draws on top of the app. We track the keyboard
  // height ourselves and translate the input/accessory area above the IME without
  // changing the terminal frame height, so keyboard open/close does not resize
  // the desktop PTY.
  const [keyboardHeight, setKeyboardHeight] = useState(0)
  // Why: server-authoritative display mode per terminal. The runtime is the
  // single source of truth — this state is populated from subscribe responses.
  const [terminalModes, setTerminalModes] = useState<Map<string, MobileDisplayMode>>(new Map())
  const [terminalKeyboardMetrics, setTerminalKeyboardMetrics] = useState<
    Map<string, TerminalKeyboardAvoidanceMetrics>
  >(new Map())
  const [selectModeActive, setSelectModeActive] = useState(false)
  const [canPaste, setCanPaste] = useState(false)
  const [showDictationSetup, setShowDictationSetup] = useState(false)
  // 'hold' makes the mic press-and-hold; 'toggle' makes it tap-to-start/stop.
  // Mirrors Settings ▸ Voice ▸ Dictation Mode so the button matches the setting.
  const [dictationMode, setDictationMode] = useState<'toggle' | 'hold'>('toggle')
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const toastOpacityRef = useRef(new Animated.Value(0))
  const toastHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastSeqRef = useRef(0)
  // Why: WebView pushes terminal modes (bracketed-paste, alt-screen) on every
  // change so paste reads a synchronous snapshot — no round-trip required.
  const ptyModesRef = useRef<Map<string, TerminalModes>>(new Map())
  const terminalGestureInputBucketsRef = useRef<Map<string, TerminalGestureInputBucket>>(new Map())
  const terminalGestureInputQueuesRef = useRef<Map<string, TerminalGestureInputQueue>>(new Map())
  const terminalGestureInputInFlightRef = useRef<Set<string>>(new Set())
  const initialModesSeenRef = useRef<Set<string>>(new Set())
  const deviceTokenRef = useRef<string | null>(null)
  const clientRef = useRef<RpcClient | null>(null)
  const connStateRef = useRef<ConnectionState>(connState)
  // Why: measured once from TerminalWebView on mount, then passed with every
  // subscribe call so the server can auto-fit the PTY to phone dimensions.
  const viewportRef = useRef<{ cols: number; rows: number } | null>(null)
  const viewportMeasuredRef = useRef(false)
  const terminalRefs = useRef<Map<string, TerminalWebViewHandle>>(new Map())
  const liveInputRef = useRef<TextInput>(null)
  const liveInputFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const terminalUnsubsRef = useRef<Map<string, () => void>>(new Map())
  const subscribingHandlesRef = useRef<Set<string>>(new Set())
  const initializedHandlesRef = useRef<Set<string>>(new Set())
  // Why: WebViews load xterm.js from CDN asynchronously. Hidden WebViews
  // (opacity:0) may have delayed JS execution on iOS. We must not subscribe
  // until the WebView has fired web-ready, otherwise init() messages queue
  // and may not render reliably.
  const webReadyHandlesRef = useRef<Set<string>>(new Set())
  const activeHandleRef = useRef<string | null>(null)
  const activeSessionTabTypeRef = useRef<MobileSessionTabType | null>(null)
  const pendingActiveSessionTabIdRef = useRef<string | null>(null)
  const pendingActiveTerminalHandleRef = useRef<string | null>(null)
  // Why: a browser tab opened from a terminal-tapped HTML must be focused as an
  // Orca session tab (bridge auto-activate only flags the live webContents, not
  // the app-level active tab). We remember the page id and, once its session tab
  // syncs, activate it through the normal switchSessionTab path (which also makes
  // switching back to the terminal work). A ref breaks the callback dep cycle.
  const pendingBrowserFocusPageIdRef = useRef<string | null>(null)
  const switchSessionTabRef = useRef<((tab: MobileSessionTab) => void) | null>(null)
  // Why: handleTerminalOpenUrl is memoized on terminalLinkOpenMode, but
  // handleCreateBrowser is a per-render closure that captures the live `client`.
  // A terminal URL tap must run the CURRENT closure (the memoized one can hold a
  // render where client was still null/connecting, silently no-opping the
  // in-app-browser open). Route through a ref kept current every render.
  const handleCreateBrowserRef = useRef<((rawUrl?: string) => Promise<boolean>) | null>(null)
  const initialEmptySessionAutoCreateRef = useRef<string | null>(null)
  const markdownSaveSeqRef = useRef<Map<string, number>>(new Map())
  const markdownSaveInFlightRef = useRef<Set<string>>(new Set())
  const subscribeSeqRef = useRef<Map<string, number>>(new Map())
  // Why: post-RPC refresh timers capture this screen and must not survive
  // route reuse or unmount.
  const delayedActionTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  // Why: server-side layout state machine emits a monotonic seq on every
  // applyLayout. Track the highest seq we've observed per handle and drop
  // any scrollback/resized event with a strictly older seq — these are
  // late-arriving events from a superseded layout (e.g. phone-fit dims
  // landing after the user toggled to desktop). Drops below `>20`-window
  // gap reset (treat as a fresh subscription, e.g. server restart).
  const layoutSeqRef = useRef<Map<string, number>>(new Map())
  const sendingRef = useRef(false)
  // Why: tracks the pixel height of the terminal frame so measureFitDimensions
  // can use the exact container height instead of relying on window.innerHeight,
  // which can overstate the visible area due to layout timing.
  const terminalFrameHeightRef = useRef<number>(0)
  // Why: the terminal frame's width changes when EITHER sidebar is resized (the
  // left worktree sidebar shrinks the detail pane; the right dock takes a slice of
  // the row) without any window-dim change. Tracking the measured width lets the
  // refit hook re-fit the PTY on those resizes — see terminal-viewport-refit.ts.
  const [terminalFrameWidth, setTerminalFrameWidth] = useState(0)

  const activeSessionTab = sessionTabs.find((tab) => tab.id === activeSessionTabId) ?? null
  const canSend =
    connState === 'connected' &&
    activeHandle != null &&
    activeSessionTab?.type !== 'markdown' &&
    activeSessionTab?.type !== 'file' &&
    activeSessionTab?.type !== 'browser'
  const liveInputEnabled = activeHandle ? liveInputTerminalHandles.has(activeHandle) : false
  const [browserScreencastSupported, setBrowserScreencastSupported] = useState<boolean | null>(null)
  // Why: stable callbacks (handleFileTap) read the live value via this ref, since
  // the capability probe resolves after the callbacks are created.
  const browserScreencastSupportedRef = useRef(browserScreencastSupported)
  browserScreencastSupportedRef.current = browserScreencastSupported
  // Why: terminal gesture/input callbacks are intentionally stable and
  // imperative; keep their refs current before commit instead of one effect later.
  clientRef.current = client
  connStateRef.current = connState
  activeSessionTabTypeRef.current = activeSessionTab?.type ?? null
  sessionTabsRef.current = sessionTabs
  activeSessionTabIdRef.current = activeSessionTabId
  markdownDocsRef.current = markdownDocs
  const reconciledCreateWarningState = reconcileMobileSessionCreateWarningState(
    createWarningState,
    initialCreateWarning
  )
  // Why: Expo can reuse this screen for a new route. Reconcile before paint
  // so a dismissed old creation warning never flashes for the next session.
  if (reconciledCreateWarningState !== createWarningState) {
    setCreateWarningState(reconciledCreateWarningState)
  }
  const createWarning = reconciledCreateWarningState.visible

  const clearDelayedActionTimers = useCallback(() => {
    for (const timer of delayedActionTimersRef.current) {
      clearTimeout(timer)
    }
    delayedActionTimersRef.current.clear()
  }, [])

  const scheduleDelayedAction = useCallback((fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      delayedActionTimersRef.current.delete(timer)
      fn()
    }, ms)
    delayedActionTimersRef.current.add(timer)
  }, [])

  const clearToastHideTimer = useCallback(() => {
    if (!toastHideTimerRef.current) {
      return
    }
    clearTimeout(toastHideTimerRef.current)
    toastHideTimerRef.current = null
  }, [])

  const showToast = useCallback(
    (message: string, durationMs = 1200) => {
      const seq = toastSeqRef.current + 1
      toastSeqRef.current = seq
      clearToastHideTimer()
      setToastMessage(message)
      Animated.timing(toastOpacityRef.current, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true
      }).start(({ finished }) => {
        if (!finished || toastSeqRef.current !== seq) {
          return
        }
        toastHideTimerRef.current = setTimeout(() => {
          toastHideTimerRef.current = null
          Animated.timing(toastOpacityRef.current, {
            toValue: 0,
            duration: 200,
            useNativeDriver: true
          }).start((result) => {
            if (result.finished && toastSeqRef.current === seq) {
              setToastMessage(null)
            }
          })
        }, durationMs)
      })
    },
    [clearToastHideTimer]
  )

  const dictation = useMobileDictation({
    client,
    enabled: canSend,
    onTranscript: (text) => {
      setInput((current) => {
        if (!current.trim()) {
          return text
        }
        return `${current.trimEnd()} ${text}`
      })
      showToast('Dictation inserted')
    },
    onError: (err) => {
      // Dictation isn't set up on the desktop yet → open the setup sheet so the
      // user can download a model + enable it from here, instead of a dead-end toast.
      if (isDictationSetupRequiredError(err.message)) {
        setShowDictationSetup(true)
        return
      }
      triggerError()
      showToast(err.message)
    }
  })

  const startDictation = useCallback(() => {
    void dictation.start().catch((err) => {
      triggerError()
      showToast(err instanceof Error ? err.message : String(err))
    })
  }, [dictation, triggerError, showToast])

  // Toggle mode: one tap starts, the next stops; long-press cancels mid-record.
  const handleDictationToggle = useCallback(() => {
    if (dictation.isProcessing) {
      void dictation.cancel()
    } else if (dictation.isStarting) {
      return
    } else if (dictation.isRecording) {
      void dictation.stop()
    } else {
      startDictation()
    }
  }, [dictation, startDictation])

  // Hold mode: press starts, release stops — like a walkie-talkie.
  const handleDictationPressIn = useCallback(() => {
    if (!dictation.isStarting && !dictation.isRecording && !dictation.isProcessing) {
      startDictation()
    }
  }, [dictation, startDictation])

  const handleDictationPressOut = useCallback(() => {
    if (dictation.isRecording) {
      void dictation.stop()
    } else if (dictation.isStarting) {
      // Released before recording began: cancel so we don't leave a live mic.
      void dictation.cancel()
    }
  }, [dictation])

  const refreshDictationMode = useCallback(async () => {
    if (!client) {
      return
    }
    try {
      const setup = await fetchDictationSetup(client)
      setDictationMode(setup.dictationMode)
    } catch {
      // Non-fatal: fall back to the default toggle behavior.
    }
  }, [client])

  // Re-read on focus so a Dictation Mode change made in Settings ▸ Voice is
  // reflected when the user returns to the session.
  useFocusEffect(
    useCallback(() => {
      void refreshDictationMode()
    }, [refreshDictationMode])
  )

  useEffect(() => {
    diffCommentsRef.current = diffComments
  }, [diffComments])

  const getTerminalRef = useCallback((handle: string | null) => {
    return handle ? terminalRefs.current.get(handle) : undefined
  }, [])

  const unsubscribeTerminal = useCallback((handle: string) => {
    terminalUnsubsRef.current.get(handle)?.()
    terminalUnsubsRef.current.delete(handle)
    subscribingHandlesRef.current.delete(handle)
    subscribeSeqRef.current.set(handle, (subscribeSeqRef.current.get(handle) ?? 0) + 1)
    // Why: a fresh subscription will land on a new server-side state machine
    // run (or the same one with a higher seq); reset the high-water mark so
    // the first scrollback isn't accidentally dropped as stale.
    layoutSeqRef.current.delete(handle)
  }, [])

  const clearTerminalCache = useCallback(() => {
    for (const unsub of terminalUnsubsRef.current.values()) {
      unsub()
    }
    terminalUnsubsRef.current.clear()
    subscribingHandlesRef.current.clear()
    initializedHandlesRef.current.clear()
    webReadyHandlesRef.current.clear()
    subscribeSeqRef.current.clear()
    layoutSeqRef.current.clear()
    setTerminalKeyboardMetrics(new Map())
    for (const term of terminalRefs.current.values()) {
      term.clear()
    }
  }, [])

  // Why: measures the phone viewport once from the first available TerminalWebView.
  // The viewport dims are passed with every subscribe call so the server can
  // auto-fit the PTY without a separate RPC round-trip.
  const measureViewportOnce = useCallback(
    async (handle: string) => {
      if (viewportMeasuredRef.current) {
        return
      }
      const dims = await getTerminalRef(handle)?.measureFitDimensions(
        terminalFrameHeightRef.current || undefined
      )
      if (dims) {
        viewportRef.current = dims
        viewportMeasuredRef.current = true
      }
    },
    [getTerminalRef]
  )

  const subscribeToTerminal = useCallback(
    (handle: string) => {
      if (!client) {
        return
      }
      if (terminalUnsubsRef.current.has(handle)) {
        return
      }
      if (subscribingHandlesRef.current.has(handle)) {
        return
      }
      if (!getTerminalRef(handle)) {
        return
      }
      if (!webReadyHandlesRef.current.has(handle)) {
        return
      }

      subscribingHandlesRef.current.add(handle)
      const seq = (subscribeSeqRef.current.get(handle) ?? 0) + 1
      subscribeSeqRef.current.set(handle, seq)

      // Why: server handles auto-fit on subscribe — no terminal.focus call needed.
      // The viewport is embedded in the subscribe params so the server resizes
      // the PTY before serializing scrollback. This eliminates the focus→safeFit
      // race and the measure→resize→resubscribe pipeline.
      const unsub = client.subscribe(
        'terminal.subscribe',
        {
          terminal: handle,
          client: { id: deviceTokenRef.current!, type: 'mobile' as const },
          viewport: viewportRef.current ?? undefined,
          capabilities: { terminalBinaryStream: 1 }
        },
        (result) => {
          if (subscribeSeqRef.current.get(handle) !== seq) {
            return
          }
          const data = result as Record<string, unknown>
          // Why: stale-event filter. Server-side state machine bumps a
          // monotonic seq on every applyLayout. Drop `resized` events
          // whose seq is strictly older than what we've already observed
          // for this handle — they're late-arriving from a superseded
          // layout. `scrollback` is the response to a fresh subscribe,
          // so it always resets the high-water mark regardless of seq
          // (post-WS-reconnect or post-resubscribe the server may emit
          // scrollback at a seq lower than what we'd seen pre-reconnect;
          // dropping it would leave the user with a blank terminal).
          const eventSeq = typeof data.seq === 'number' ? data.seq : null
          if (eventSeq != null && data.type === 'resized') {
            const last = layoutSeqRef.current.get(handle)
            if (last != null && eventSeq < last && last - eventSeq <= 20) {
              console.log('[fit][session] DROP-stale-seq', {
                handle: handle.slice(-8),
                type: data.type,
                eventSeq,
                lastSeq: last,
                cols: data.cols,
                rows: data.rows,
                displayMode: data.displayMode
              })
              return
            }
            layoutSeqRef.current.set(handle, eventSeq)
          } else if (eventSeq != null && data.type === 'scrollback') {
            layoutSeqRef.current.set(handle, eventSeq)
          }
          if (data.type === 'subscribed') {
            return
          }
          if (data.type === 'scrollback') {
            if (initializedHandlesRef.current.has(handle)) {
              return
            }
            const cols = (data.cols as number) || 80
            const rows = (data.rows as number) || 24
            const scrollbackCols = cols
            const scrollbackRows = rows
            const initialData =
              typeof data.serialized === 'string' && data.serialized.length > 0
                ? data.serialized
                : ''
            const ref = getTerminalRef(handle)
            // Why: previously we set `initializedHandlesRef` even when the
            // WebView wasn't mounted yet (ref=null). The init message went
            // nowhere, but the flag stayed true, so any subsequent scrollback
            // for THIS handle was silently dropped → blank terminal. Only
            // mark initialized if init() actually reached the WebView.
            if (!ref) {
              console.log('[fit][session] scrollback DROPPED — no terminal ref', {
                handle: handle.slice(-8),
                cols,
                rows
              })
              return
            }
            ref.init(cols, rows, initialData)
            initializedHandlesRef.current.add(handle)
            if (data.displayMode) {
              setTerminalModes((prev) =>
                new Map(prev).set(handle, data.displayMode as MobileDisplayMode)
              )
            }
            // Why: belt-and-suspenders cold-start fit. The applyFitScale
            // queued by init() runs after writes drain, but on cold start
            // xterm's scrollWidth can still be transient when it commits.
            // Re-fire after a short delay so it runs against a settled DOM.
            // Mirrors the 'resized' handler below.
            scheduleDelayedAction(() => getTerminalRef(handle)?.resetZoom(), 200)
            // Why: viewport measurement needs xterm to be initialized (cell
            // dimensions come from the renderer). On the first subscribe the
            // WebView hasn't loaded yet, so viewportRef is null and the server
            // can't auto-fit. After the first init we can measure, then
            // resubscribe so the server gets the viewport and phone-fits.
            // If viewport was measured by a parallel path BUT the scrollback
            // we just received came back at desktop dims, our subscribe
            // beat the measure; the server still has a null viewport for
            // this subscriber record — resubscribe so it gets stored.
            const needsResubscribe =
              !viewportMeasuredRef.current ||
              (viewportRef.current != null &&
                (scrollbackCols !== viewportRef.current.cols ||
                  scrollbackRows !== viewportRef.current.rows))
            if (needsResubscribe) {
              void (async () => {
                // Why: wait for the WebView's init() rAF chain to fully
                // run (term.open → renderService population → first
                // paint) before measuring. Without this, the measure
                // postMessage races ahead of init's async work and
                // returns null (term not ready / cells size 0), the
                // resubscribe never fires, and the server never gets
                // phone dims. See log dump 2026-05-06 confirming the
                // race + measure-result null pattern.
                await getTerminalRef(handle)?.awaitReady()
                if (subscribeSeqRef.current.get(handle) !== seq) {
                  return
                }
                const dims = await getTerminalRef(handle)?.measureFitDimensions(
                  terminalFrameHeightRef.current || undefined
                )
                // Why: re-check seq after the awaits — awaitReady (up to
                // 3s) and measureFitDimensions can take hundreds of ms,
                // during which a newer subscribe cycle may have armed
                // its own subscription. Tearing it down here would reset
                // the freshly-armed initialized flag and re-subscribe a
                // stale generation.
                if (subscribeSeqRef.current.get(handle) !== seq) {
                  return
                }
                if (!getTerminalRef(handle)) {
                  return
                }
                // Why: we just got `scrollback` with cols=80 (server's
                // default fallback for null viewport). That means the
                // server-side subscriber record was registered before we
                // could send viewport. Even if `viewportMeasuredRef`
                // raced ahead via a parallel `measureViewportOnce`, the
                // server still has a null viewport for THIS subscriber
                // record — we MUST resubscribe so the server stores it.
                if (dims) {
                  viewportRef.current = dims
                  viewportMeasuredRef.current = true
                  unsubscribeTerminal(handle)
                  initializedHandlesRef.current.delete(handle)
                  subscribeToTerminal(handle)
                }
              })()
            }
          } else if (data.type === 'data') {
            // Why: log when data arrives but the WebView ref is missing
            // — this is the most likely cause of "blank but input works":
            // server stream is alive, sends flow, but writes are dropped
            // because the WebView ref disappeared (unmount mid-flight) or
            // the scrollback never landed (so xterm has no buffer).
            const dataRef = getTerminalRef(handle)
            if (!dataRef) {
              console.log('[fit][session] data DROPPED — no terminal ref', {
                handle: handle.slice(-8),
                chunkLen: typeof data.chunk === 'string' ? data.chunk.length : 0,
                initialized: initializedHandlesRef.current.has(handle)
              })
              return
            }
            if (!initializedHandlesRef.current.has(handle)) {
              console.log('[fit][session] data RECEIVED before scrollback', {
                handle: handle.slice(-8),
                chunkLen: typeof data.chunk === 'string' ? data.chunk.length : 0
              })
            }
            dataRef.write(data.chunk as string)
          } else if (data.type === 'resized') {
            // Why: inline resize event — the server changed the PTY dimensions
            // (mode toggle, desktop restore, or a width reflow). When the server
            // includes a fresh full-buffer snapshot (width reflow), reinitialize
            // xterm at the new dims so the hard-wrapped scrollback rewraps;
            // preserve the reader's scroll position across the replay. Otherwise
            // resize xterm geometry and let the TUI's own redraw repaint.
            const cols = (data.cols as number) || 80
            const rows = (data.rows as number) || 24
            const serialized = typeof data.serialized === 'string' ? data.serialized : null
            if (serialized != null) {
              getTerminalRef(handle)?.init(cols, rows, serialized, true)
            } else {
              getTerminalRef(handle)?.resize(cols, rows)
            }
            if (data.displayMode) {
              setTerminalModes((prev) =>
                new Map(prev).set(handle, data.displayMode as MobileDisplayMode)
              )
            }
            scheduleDelayedAction(() => getTerminalRef(handle)?.resetZoom(), 200)
          }
        }
      )

      if (subscribeSeqRef.current.get(handle) === seq) {
        terminalUnsubsRef.current.set(handle, unsub)
      } else {
        unsub()
      }
      subscribingHandlesRef.current.delete(handle)
    },
    [client, getTerminalRef, scheduleDelayedAction]
  )

  // Why: toggles between phone and desktop mode via server RPC. The server
  // handles the actual resize and emits a 'resized' event on the existing
  // subscription stream — no client-side state tracking needed.
  const toggleInFlightRef = useRef<Set<string>>(new Set())
  const toggleDisplayMode = useCallback(
    async (handle: string) => {
      if (!client) {
        return
      }
      if (toggleInFlightRef.current.has(handle)) {
        return
      }
      const current = terminalModes.get(handle) ?? 'auto'
      // Why: 'phone' on the wire is an observation ("currently phone-fitted"),
      // not a setting. The toggle only ever requests 'auto' or 'desktop'.
      const next: 'auto' | 'desktop' =
        current === 'auto' || current === 'phone' ? 'desktop' : 'auto'
      toggleInFlightRef.current.add(handle)
      try {
        await client.sendRequest('terminal.setDisplayMode', {
          terminal: handle,
          mode: next,
          // Why: presence-lock take-floor signal — requesting 'auto' is the
          // explicit "I want to drive at phone dims" gesture.
          ...(deviceTokenRef.current
            ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
            : {}),
          // Why: late-bind viewport for terminals whose subscribe record
          // was registered before measurement landed. Without this the
          // server's stored viewport is null and auto toggles no-op.
          ...(viewportRef.current && next === 'auto' ? { viewport: viewportRef.current } : {})
        })
      } catch {
        // Mode change failed — server state unchanged, UI stays in sync.
      } finally {
        toggleInFlightRef.current.delete(handle)
      }
    },
    [client, terminalModes]
  )

  const lastKnownTerminalCountRef = useRef(0)
  const fetchTerminalsInFlightRef = useRef(false)

  const fetchTerminals = useCallback(
    async (opts: { allowEmptyLoaded?: boolean } = {}) => {
      if (!client) {
        return
      }
      if (fetchTerminalsInFlightRef.current) {
        return
      }
      fetchTerminalsInFlightRef.current = true
      const allowEmptyLoaded = opts.allowEmptyLoaded ?? true

      try {
        const response = await client.sendRequest('terminal.list', {
          worktree: `id:${worktreeId}`
        })
        if (response.ok) {
          const result = (response as RpcSuccess).result as { terminals: Terminal[] }

          if (result.terminals.length === 0 && !allowEmptyLoaded) {
            return
          }
          // Why: protect against transient empty responses from the server
          // during rapid tab switching or RPC timing. If we previously had
          // terminals and the server now says 0, require a second consecutive
          // empty to confirm. This prevents the UI from flashing empty during
          // rapid interactions while still allowing genuine cleanup.
          if (result.terminals.length === 0 && lastKnownTerminalCountRef.current > 0) {
            lastKnownTerminalCountRef.current = 0
            return
          }

          const liveHandles = new Set(result.terminals.map((terminal) => terminal.handle))
          for (const handle of Array.from(terminalUnsubsRef.current.keys())) {
            if (!liveHandles.has(handle)) {
              unsubscribeTerminal(handle)
              terminalRefs.current.delete(handle)
              initializedHandlesRef.current.delete(handle)
              setTerminalKeyboardMetrics((prev) => {
                if (!prev.has(handle)) {
                  return prev
                }
                const next = new Map(prev)
                next.delete(handle)
                return next
              })
            }
          }
          lastKnownTerminalCountRef.current = result.terminals.length
          // Why: defense-in-depth dedupe. If the server ever returns a list
          // with the same handle twice (race during rename/split, or stale
          // process tracking), React would throw 'two children with same
          // key' on render. Keep the first occurrence — list order matters
          // for the tab strip, and createParams puts new tabs at the end.
          const seen = new Set<string>()
          const deduped = result.terminals.filter((t) => {
            if (seen.has(t.handle)) {
              return false
            }
            seen.add(t.handle)
            return true
          })

          const mergedTerminals = mergeTerminalListWithKnownRecords(
            deduped,
            terminalsRef.current,
            sessionTabsRef.current
          )
          setTerminals((prev) =>
            terminalRecordsEqual(prev, mergedTerminals) ? prev : mergedTerminals
          )
          terminalsRef.current = mergedTerminals

          // Session tabs are the UI authority. terminal.list only refreshes
          // per-handle metadata for existing ready terminal surfaces.
        }
      } catch {
        // Failed to list terminals
      } finally {
        fetchTerminalsInFlightRef.current = false
      }
    },
    [client, worktreeId, subscribeToTerminal, unsubscribeTerminal]
  )

  const applySessionTabs = useCallback(
    (result: SessionTabsResult) => {
      let nextTabs = result.tabs
      const presentTabIds = new Set(nextTabs.map((tab) => tab.id))
      const orphanedDraftTabs: MobileSessionTab[] = []
      const currentMarkdownDocs = markdownDocsRef.current
      const currentSessionTabs = sessionTabsRef.current
      for (const [tabId, doc] of currentMarkdownDocs) {
        if (doc.status !== 'ready' || !doc.isDirty || presentTabIds.has(tabId)) {
          continue
        }
        const draftTab = currentSessionTabs.find(
          (tab): tab is Extract<MobileSessionTab, { type: 'markdown' }> =>
            tab.type === 'markdown' && tab.id === tabId
        )
        if (draftTab) {
          // Why: save-only mobile edits live only on the phone until Save. If the
          // desktop tab disappears, keep every local draft reachable for copy/discard.
          orphanedDraftTabs.push({ ...draftTab, isActive: tabId === activeSessionTabIdRef.current })
        }
      }
      if (orphanedDraftTabs.length > 0) {
        nextTabs = [...orphanedDraftTabs, ...nextTabs]
      }
      sessionTabsRef.current = nextTabs
      // Why: subscribe snapshots often repeat identical tab payloads. Avoid a
      // render loop where the subscription effect tears down and replays itself.
      setSessionTabs((prev) => (mobileSessionTabsEqual(prev, nextTabs) ? prev : nextTabs))
      const terminalTabs = getTerminalRecordsFromSessionTabs(nextTabs)
      const mergedTerminalsForActive = mergeTerminalRecordsByCurrentOrder(
        terminalTabs,
        terminalsRef.current
      )
      terminalsRef.current = mergedTerminalsForActive
      setTerminals((prev) =>
        terminalRecordsEqual(prev, mergedTerminalsForActive) ? prev : mergedTerminalsForActive
      )
      lastKnownTerminalCountRef.current = Math.max(
        lastKnownTerminalCountRef.current,
        terminalTabs.length
      )
      setTerminalsLoaded(true)

      const snapshotActive = nextTabs.find((tab) => tab.isActive) ?? nextTabs[0] ?? null
      const pendingActiveSessionTabId = pendingActiveSessionTabIdRef.current
      const pendingActiveTerminalHandle = pendingActiveTerminalHandleRef.current
      let active = snapshotActive
      if (pendingActiveSessionTabId) {
        if (snapshotActive?.id === pendingActiveSessionTabId) {
          pendingActiveSessionTabIdRef.current = null
        } else {
          const pendingTab = nextTabs.find((tab) => tab.id === pendingActiveSessionTabId)
          if (pendingTab) {
            // Why: desktop tab snapshots can lag a mobile tap while activate RPC
            // is in flight. Keep the locally selected tab to avoid snapping back.
            active = pendingTab
          } else {
            pendingActiveSessionTabIdRef.current = null
          }
        }
      }
      if (pendingActiveTerminalHandle) {
        const pendingTerminalTab = nextTabs.find(
          (tab): tab is Extract<MobileSessionTab, { type: 'terminal' }> =>
            tab.type === 'terminal' && tab.terminal === pendingActiveTerminalHandle
        )
        const pendingTerminalExists = mergedTerminalsForActive.some(
          (terminal) => terminal.handle === pendingActiveTerminalHandle
        )
        if (
          snapshotActive?.type === 'terminal' &&
          snapshotActive.terminal === pendingActiveTerminalHandle
        ) {
          pendingActiveTerminalHandleRef.current = null
        } else if (pendingTerminalTab) {
          // Why: desktop active flags can lag a mobile terminal tap. Key by
          // terminal handle too, because fallback PTY tabs may not yet have a
          // stable session tab id during new-worktree startup.
          active = pendingTerminalTab
        } else if (pendingTerminalExists) {
          const nextActiveTabId = getActiveTabIdForHandle(nextTabs, pendingActiveTerminalHandle)
          activeSessionTabIdRef.current = nextActiveTabId
          setActiveSessionTabId(nextActiveTabId)
          activeSessionTabTypeRef.current = 'terminal'
          setActiveHandle(pendingActiveTerminalHandle)
          subscribeToTerminal(pendingActiveTerminalHandle)
          return
        } else {
          pendingActiveTerminalHandleRef.current = null
        }
      }
      activeSessionTabTypeRef.current = active?.type ?? null
      activeSessionTabIdRef.current = active?.id ?? null
      setActiveSessionTabId(active?.id ?? null)
      if (active?.type === 'terminal') {
        if (typeof active.terminal !== 'string') {
          const previous = activeHandleRef.current
          if (previous) {
            unsubscribeTerminal(previous)
            initializedHandlesRef.current.delete(previous)
          }
          activeHandleRef.current = null
          setActiveHandle(null)
          return
        }
        const previous = activeHandleRef.current
        if (previous && previous !== active.terminal) {
          unsubscribeTerminal(previous)
          initializedHandlesRef.current.delete(previous)
        }
        activeHandleRef.current = active.terminal
        setActiveHandle(active.terminal)
        subscribeToTerminal(active.terminal)
      } else if (active) {
        const previous = activeHandleRef.current
        if (previous) {
          unsubscribeTerminal(previous)
          initializedHandlesRef.current.delete(previous)
        }
        activeHandleRef.current = null
        setActiveHandle(null)
      }
    },
    [subscribeToTerminal, unsubscribeTerminal]
  )

  const readMarkdownTab = useCallback(
    async (tab: Extract<MobileSessionTab, { type: 'markdown' }>) => {
      if (!client) {
        return
      }
      setMarkdownDocs((prev) => new Map(prev).set(tab.id, { status: 'loading' }))
      try {
        const response = await client.sendRequest('markdown.readTab', {
          worktree: `id:${worktreeId}`,
          tabId: tab.id
        })
        if (response.ok) {
          const result = (response as RpcSuccess).result as {
            content: string
            version: string
            isDirty: boolean
            editable?: boolean
            readOnlyReason?: string
          }
          setMarkdownDocs((prev) =>
            new Map(prev).set(tab.id, {
              status: 'ready',
              content: result.content,
              localContent: result.content,
              baseVersion: result.version,
              isDirty: false,
              editable: result.editable === true,
              stale: result.isDirty,
              readOnlyReason: result.readOnlyReason
            })
          )
          return
        }
        if (!shouldReadMarkdownFromDiskAfterReadTabFailure(response as RpcFailure)) {
          throw new Error((response as RpcFailure).error.message)
        }
        // Why: a headless host (no desktop renderer) can't serve the live editor
        // document and fails markdown.readTab with renderer_unavailable. Fall back
        // to the on-disk file so markdown still renders read-only, matching how
        // other file types load via files.read.
        const fallback = await client.sendRequest('files.read', {
          worktree: `id:${worktreeId}`,
          relativePath: tab.relativePath
        })
        if (!fallback.ok) {
          throw new Error('Unable to read markdown')
        }
        const fileResult = (fallback as RpcSuccess).result as {
          content: string
          truncated: boolean
          byteLength: number
        }
        setMarkdownDocs((prev) =>
          new Map(prev).set(
            tab.id,
            buildMarkdownDiskFallbackDoc({
              content: fileResult.content,
              truncated: fileResult.truncated,
              tabIsDirty: tab.isDirty
            })
          )
        )
      } catch {
        setMarkdownDocs((prev) =>
          new Map(prev).set(tab.id, {
            status: 'error',
            message: "Couldn't load markdown"
          })
        )
      }
    },
    [client, worktreeId]
  )

  const readFileTab = useCallback(
    async (tab: Extract<MobileSessionTab, { type: 'file' }>) => {
      if (!client) {
        return
      }
      setFileDocs((prev) => new Map(prev).set(tab.id, { status: 'loading' }))
      try {
        if (tab.diffSource === 'staged' || tab.diffSource === 'unstaged') {
          const response = await client.sendRequest('git.diff', {
            worktree: `id:${worktreeId}`,
            filePath: tab.relativePath,
            staged: tab.diffSource === 'staged'
          })
          if (!response.ok) {
            throw new Error((response as RpcFailure).error.message)
          }
          const result = (response as RpcSuccess).result as
            | {
                kind: 'text'
                originalContent: string
                modifiedContent: string
              }
            | { kind: 'binary' }
          if (result.kind !== 'text') {
            throw new Error('binary_file')
          }
          const diff = buildMobileDiffLines(result.originalContent, result.modifiedContent)
          setFileDocs((prev) =>
            new Map(prev).set(tab.id, {
              status: 'ready',
              kind: 'diff',
              lines: diff.lines,
              truncated: diff.truncated
            })
          )
          return
        }
        const artifactKind = classifyMobileArtifact(tab.relativePath)
        if (artifactKind === 'image') {
          const preview = await client.sendRequest('files.readPreview', {
            worktree: `id:${worktreeId}`,
            relativePath: tab.relativePath
          })
          if (!preview.ok) {
            throw new Error((preview as RpcFailure).error.message)
          }
          const result = (preview as RpcSuccess).result as {
            content: string
            isImage?: boolean
            mimeType?: string
          }
          if (!result.isImage || !result.mimeType || result.content.length === 0) {
            throw new Error('binary_file')
          }
          setFileDocs((prev) =>
            new Map(prev).set(tab.id, {
              status: 'ready',
              kind: 'image',
              dataUri: `data:${result.mimeType};base64,${result.content}`
            })
          )
          return
        }
        const response = await client.sendRequest('files.read', {
          worktree: `id:${worktreeId}`,
          relativePath: tab.relativePath
        })
        if (!response.ok) {
          throw new Error((response as RpcFailure).error.message)
        }
        const result = (response as RpcSuccess).result as {
          content: string
          truncated: boolean
          byteLength: number
        }
        if (artifactKind === 'html') {
          setFileDocs((prev) =>
            new Map(prev).set(tab.id, {
              status: 'ready',
              kind: 'html',
              content: result.content
            })
          )
          return
        }
        setFileDocs((prev) =>
          new Map(prev).set(tab.id, {
            status: 'ready',
            kind: 'file',
            content: result.content,
            truncated: result.truncated,
            byteLength: result.byteLength
          })
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : ''
        const previewMessage =
          message === 'binary_file'
            ? 'Binary preview unavailable'
            : message === 'file_too_large'
              ? 'File too large for mobile preview'
              : tab.diffSource === 'staged' || tab.diffSource === 'unstaged'
                ? "Couldn't load diff preview"
                : "Couldn't load file preview"
        setFileDocs((prev) =>
          new Map(prev).set(tab.id, {
            status: 'error',
            message: previewMessage
          })
        )
      }
    },
    [client, worktreeId]
  )

  const loadDiffComments = useCallback(async (): Promise<void> => {
    if (!client || connState !== 'connected' || !worktreeId) {
      setDiffComments([])
      return
    }
    const response = await client.sendRequest('worktree.show', {
      worktree: `id:${worktreeId}`
    })
    if (!response.ok) {
      return
    }
    const result = (response as RpcSuccess).result as {
      worktree?: { diffComments?: unknown }
    }
    setDiffComments(normalizeMobileDiffComments(result.worktree?.diffComments, worktreeId))
  }, [client, connState, worktreeId])

  const persistDiffComments = useCallback(
    async (comments: readonly DiffComment[]): Promise<void> => {
      if (!client || connState !== 'connected') {
        throw new Error('Waiting for desktop...')
      }
      const response = await client.sendRequest('worktree.set', {
        worktree: `id:${worktreeId}`,
        diffComments: comments
      })
      if (!response.ok) {
        throw new Error((response as RpcFailure).error.message || 'Failed to save review notes')
      }
    },
    [client, connState, worktreeId]
  )

  useEffect(() => {
    void loadDiffComments()
  }, [loadDiffComments])

  const addDiffCommentForFile = useCallback(
    async (filePath: string, lineNumber: number, body: string): Promise<boolean> => {
      if (diffCommentBusy) {
        return false
      }
      const nextId = `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const result = addMobileDiffComment(diffCommentsRef.current, {
        id: nextId,
        worktreeId,
        filePath,
        lineNumber,
        body,
        createdAt: Date.now()
      })
      if (!result.comment) {
        return false
      }
      const previous = diffCommentsRef.current
      setDiffCommentBusy(true)
      setDiffComments(result.comments)
      try {
        await persistDiffComments(result.comments)
        triggerSuccess()
        showToast('Note added')
        return true
      } catch (err) {
        setDiffComments(previous)
        triggerError()
        showToast(err instanceof Error ? err.message : 'Failed to save note', 1600)
        return false
      } finally {
        setDiffCommentBusy(false)
      }
    },
    [diffCommentBusy, persistDiffComments, showToast, worktreeId]
  )

  const deleteDiffCommentForFile = useCallback(
    async (commentId: string): Promise<void> => {
      if (diffCommentBusy) {
        return
      }
      const previous = diffCommentsRef.current
      const next = removeMobileDiffComments(previous, new Set([commentId]))
      if (next.length === previous.length) {
        return
      }
      setDiffCommentBusy(true)
      setDiffComments(next)
      try {
        await persistDiffComments(next)
        triggerSelection()
      } catch (err) {
        setDiffComments(previous)
        triggerError()
        showToast(err instanceof Error ? err.message : 'Failed to delete note', 1600)
      } finally {
        setDiffCommentBusy(false)
      }
    },
    [diffCommentBusy, persistDiffComments, showToast]
  )

  const copyDiffCommentsToClipboard = useCallback(async (): Promise<void> => {
    const comments = diffCommentsRef.current
    if (comments.length === 0) {
      return
    }
    try {
      await Clipboard.setStringAsync(formatDiffComments(comments))
      triggerSuccess()
      showToast('Notes copied')
    } catch {
      triggerError()
      showToast("Couldn't copy notes", 1600)
    }
  }, [showToast])

  const sendDiffCommentsToAgent = useCallback((): void => {
    const comments = diffCommentsRef.current.filter((comment) => !comment.sentAt)
    if (comments.length === 0) {
      return
    }
    setPendingDiffNotesDelivery({
      comments: [...comments],
      prompt: formatDiffComments(comments)
    })
  }, [])

  const clearDeliveredDiffComments = useCallback(
    async (delivered: readonly DiffComment[]): Promise<void> => {
      const previous = diffCommentsRef.current
      const next = removeDeliveredMobileDiffComments(previous, delivered)
      if (next.length === previous.length) {
        return
      }
      setDiffCommentBusy(true)
      setDiffComments(next)
      try {
        await persistDiffComments(next)
      } catch {
        setDiffComments(previous)
      } finally {
        setDiffCommentBusy(false)
      }
    },
    [persistDiffComments]
  )

  const updateMarkdownLocalContent = useCallback((tabId: string, content: string) => {
    setMarkdownDocs((prev) => {
      const current = prev.get(tabId)
      if (current?.status !== 'ready') {
        return prev
      }
      const next = new Map(prev)
      next.set(tabId, {
        ...current,
        localContent: content,
        isDirty: content !== current.content,
        saveError: undefined
      })
      return next
    })
  }, [])

  const copyMarkdownLocalContent = useCallback(
    async (tabId: string) => {
      const current = markdownDocs.get(tabId)
      if (current?.status !== 'ready') {
        return
      }
      await Clipboard.setStringAsync(current.localContent)
      triggerSuccess()
      showToast('Copied')
    },
    [markdownDocs, showToast]
  )

  const getDirtyMarkdownDrafts = useCallback(() => {
    const drafts: DirtyMarkdownDraft[] = []
    for (const [tabId, doc] of markdownDocs) {
      if (doc.status === 'ready' && doc.isDirty) {
        const tab = sessionTabs.find((candidate) => candidate.id === tabId)
        drafts.push({ tabId, title: tab?.title || 'Markdown', content: doc.localContent })
      }
    }
    return drafts
  }, [markdownDocs, sessionTabs])

  const leaveSession = useCallback(() => {
    if (router.canGoBack()) {
      router.back()
      return
    }
    // Why: Android back can arrive when this session is the root route; using
    // replace avoids React Navigation's dev-only unhandled GO_BACK warning.
    router.replace(`/h/${hostId}`)
  }, [hostId, router])

  const requestLeaveSession = useCallback(() => {
    const dirtyDrafts = getDirtyMarkdownDrafts()
    if (dirtyDrafts.length === 0) {
      leaveSession()
      return
    }
    Keyboard.dismiss()
    setLeaveDrafts(dirtyDrafts)
  }, [getDirtyMarkdownDrafts, leaveSession])

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      requestLeaveSession()
      return true
    })
    return () => subscription.remove()
  }, [requestLeaveSession])

  const discardMarkdownLocalContent = useCallback(
    (tab: Extract<MobileSessionTab, { type: 'markdown' }>) => {
      const current = markdownDocs.get(tab.id)
      if (current?.status !== 'ready') {
        return
      }
      if (!current.isDirty) {
        void readMarkdownTab(tab)
        return
      }
      Keyboard.dismiss()
      setDiscardMarkdownTarget(tab)
    },
    [markdownDocs, readMarkdownTab]
  )

  const confirmDiscardMarkdown = useCallback(() => {
    const target = discardMarkdownTarget
    setDiscardMarkdownTarget(null)
    if (target) {
      void readMarkdownTab(target)
    }
  }, [discardMarkdownTarget, readMarkdownTab])

  const saveMarkdownTab = useCallback(
    async (tab: Extract<MobileSessionTab, { type: 'markdown' }>) => {
      if (!client) {
        return
      }
      const current = markdownDocs.get(tab.id)
      if (current?.status !== 'ready' || current.saving || !current.editable) {
        return
      }
      if (markdownSaveInFlightRef.current.has(tab.id)) {
        return
      }
      markdownSaveInFlightRef.current.add(tab.id)
      const saveSeq = (markdownSaveSeqRef.current.get(tab.id) ?? 0) + 1
      markdownSaveSeqRef.current.set(tab.id, saveSeq)
      setMarkdownDocs((prev) => {
        const existing = prev.get(tab.id)
        if (existing?.status !== 'ready') {
          return prev
        }
        return new Map(prev).set(tab.id, { ...existing, saving: true, saveError: undefined })
      })
      try {
        const response = await client.sendRequest('markdown.saveTab', {
          worktree: `id:${worktreeId}`,
          tabId: tab.id,
          baseVersion: current.baseVersion,
          content: current.localContent
        })
        if (!response.ok) {
          throw new Error((response as RpcFailure).error.message)
        }
        const result = (response as RpcSuccess).result as {
          content: string
          version: string
          isDirty: false
        }
        if (markdownSaveSeqRef.current.get(tab.id) !== saveSeq) {
          return
        }
        setMarkdownDocs((prev) =>
          new Map(prev).set(tab.id, {
            status: 'ready',
            content: result.content,
            localContent: result.content,
            baseVersion: result.version,
            isDirty: false,
            editable: true
          })
        )
        markdownSaveSeqRef.current.delete(tab.id)
        triggerSuccess()
        showToast('Saved')
      } catch (error) {
        triggerError()
        const message = error instanceof Error ? error.message : 'Save failed'
        if (markdownSaveSeqRef.current.get(tab.id) !== saveSeq) {
          return
        }
        setMarkdownDocs((prev) => {
          const existing = prev.get(tab.id)
          if (existing?.status !== 'ready') {
            return prev
          }
          return new Map(prev).set(tab.id, {
            ...existing,
            saving: false,
            saveError: message || 'Save failed'
          })
        })
      } finally {
        markdownSaveInFlightRef.current.delete(tab.id)
      }
    },
    [client, markdownDocs, showToast, worktreeId]
  )

  const fetchSessionTabsInFlightRef = useRef(false)

  const fetchSessionTabs = useCallback(async () => {
    if (!client) {
      return
    }
    if (fetchSessionTabsInFlightRef.current) {
      return
    }
    fetchSessionTabsInFlightRef.current = true
    try {
      const response = await client.sendRequest('session.tabs.list', {
        worktree: `id:${worktreeId}`
      })
      if (!response.ok) {
        return
      }
      const result = (response as RpcSuccess).result as SessionTabsResult
      applySessionTabs(result)
      // Focus a just-opened browser tab once it appears in the snapshot, via the
      // normal activate path so it sticks and the user can still switch away.
      const pendingPageId = pendingBrowserFocusPageIdRef.current
      if (pendingPageId) {
        const browserTab = result.tabs.find(
          (tab) => tab.type === 'browser' && tab.browserPageId === pendingPageId
        )
        if (browserTab) {
          pendingBrowserFocusPageIdRef.current = null
          switchSessionTabRef.current?.(browserTab)
        }
      }
    } catch {
      // Keep the last tab snapshot visible during reconnect/backoff.
    } finally {
      fetchSessionTabsInFlightRef.current = false
    }
  }, [applySessionTabs, client, worktreeId])

  useEffect(() => {
    if (connState === 'connected') {
      return
    }
    for (const queued of terminalGestureInputQueuesRef.current.values()) {
      if (queued.timer) {
        clearTimeout(queued.timer)
      }
    }
    terminalGestureInputQueuesRef.current.clear()
    terminalGestureInputInFlightRef.current.clear()
  }, [connState])

  useEffect(() => {
    if (!client || connState !== 'connected') {
      setBrowserScreencastSupported(null)
      return
    }
    let stale = false
    void client
      .sendRequest('status.get')
      .then((response) => {
        if (stale || !response.ok) {
          return
        }
        const status = (response as RpcSuccess).result as RuntimeStatusResult
        setBrowserScreencastSupported(
          status.capabilities?.includes('browser.screencast.v1') === true
        )
      })
      .catch(() => {
        if (!stale) {
          setBrowserScreencastSupported(false)
        }
      })
    return () => {
      stale = true
    }
  }, [client, connState])

  // Why: deviceToken is read from host record so feature code can pass
  // `client.id` on subscribe/send for driver-state-machine identity.
  // The shared client itself stays alive across screens; we just need
  // the token alongside the client.
  useEffect(() => {
    if (!hostId) {
      return
    }
    let stale = false
    void loadHosts().then((hosts) => {
      if (stale) {
        return
      }
      const host = hosts.find((h) => h.id === hostId)
      if (host) {
        deviceTokenRef.current = host.deviceToken
      }
    })
    return () => {
      stale = true
    }
  }, [hostId])

  useEffect(() => {
    void loadCustomKeys().then(setCustomKeys)
  }, [])

  useFocusEffect(
    useCallback(() => {
      let stale = false
      void loadTerminalAccessoryLayout().then((layout) => {
        if (!stale) {
          setVisibleBuiltInIds(layout.visibleBuiltInIds)
        }
      })
      return () => {
        stale = true
      }
    }, [])
  )

  useEffect(() => {
    let mounted = true
    const refresh = () => {
      void loadTerminalAccessoryLayout().then((layout) => {
        if (mounted) {
          setVisibleBuiltInIds(layout.visibleBuiltInIds)
        }
      })
    }
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') {
        refresh()
      }
    })
    return () => {
      mounted = false
      sub.remove()
    }
  }, [])

  // Why: viewport refits for layout changes outside the subscribe path
  // (tab strip toggling, fold/unfold, rotation) live in a dedicated hook —
  // see terminal-viewport-refit.ts for the full rationale.
  useTerminalViewportRefit({
    activeHandleRef,
    terminalRefs,
    terminalFrameHeightRef,
    viewportRef,
    viewportMeasuredRef,
    clientRef,
    deviceTokenRef,
    initializedHandlesRef,
    tabStripVisible: terminals.length > 1,
    textScale: terminalTextScale,
    terminalFrameWidth,
    unsubscribeTerminal,
    subscribeToTerminal
  })

  useEffect(() => {
    const onShow = (e: KeyboardEvent) => {
      setKeyboardHeight(e.endCoordinates?.height ?? 0)
    }
    const onHide = () => {
      setKeyboardHeight(0)
    }
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const showSub = Keyboard.addListener(showEvent, onShow)
    const hideSub = Keyboard.addListener(hideEvent, onHide)
    return () => {
      showSub.remove()
      hideSub.remove()
    }
  }, [])

  const scrollActiveTabIntoView = useCallback((tabId: string | null, animated: boolean) => {
    if (!tabId) {
      return
    }
    const layout = tabLayoutsRef.current.get(tabId)
    if (!layout) {
      return
    }
    const nextOffset = resolveTabStripScrollOffset({
      tabX: layout.x,
      tabWidth: layout.width,
      viewportWidth: tabStripViewportWidthRef.current,
      contentWidth: tabStripContentWidthRef.current,
      currentOffset: tabStripOffsetRef.current
    })
    if (nextOffset !== tabStripOffsetRef.current) {
      tabStripOffsetRef.current = nextOffset
      tabStripRef.current?.scrollTo({ x: nextOffset, animated })
    }
  }, [])

  // Reveal the active tab whenever it changes (e.g. desktop's open tab synced on
  // worktree entry). Defer one frame so freshly mounted tab layouts are recorded.
  useEffect(() => {
    const id = requestAnimationFrame(() => scrollActiveTabIntoView(activeSessionTabId, true))
    return () => cancelAnimationFrame(id)
  }, [activeSessionTabId, scrollActiveTabIntoView])

  useEffect(() => {
    if (hostId && worktreeId) {
      void AsyncStorage.setItem(
        'orca:last-visited-worktree',
        JSON.stringify({ hostId, worktreeId })
      )
    }
  }, [hostId, worktreeId])

  const handleDeleteCustomKey = useCallback(
    async (key: CustomKey) => {
      const updated = customKeys.filter((k) => k.id !== key.id)
      setCustomKeys(updated)
      await saveCustomKeys(updated)
    },
    [customKeys]
  )

  const handleManageShortcuts = useCallback(() => {
    setShowCustomKeyModal(false)
    router.push('/terminal-settings')
  }, [router])

  useEffect(() => {
    clearTerminalCache()
    activeHandleRef.current = null
    activeSessionTabTypeRef.current = null
    pendingActiveSessionTabIdRef.current = null
    pendingActiveTerminalHandleRef.current = null
    pendingBrowserFocusPageIdRef.current = null
    initialEmptySessionAutoCreateRef.current = null
    for (const queued of terminalGestureInputQueuesRef.current.values()) {
      if (queued.timer) {
        clearTimeout(queued.timer)
      }
    }
    terminalGestureInputQueuesRef.current.clear()
    terminalGestureInputInFlightRef.current.clear()
    setActiveHandle(null)
    setTerminals([])
    terminalsRef.current = []
    setSessionTabs([])
    setActiveSessionTabId(null)
    setLiveInputCapture('')
    setLiveInputTerminalHandles(new Set())
    setMarkdownDocs(new Map())
    setFileDocs(new Map())
    clearDelayedActionTimers()
    return () => {
      clearDelayedActionTimers()
    }
  }, [clearDelayedActionTimers, clearTerminalCache, worktreeId])

  useEffect(() => {
    if (connState !== 'connected') {
      return
    }
    // Why: the RPC client auto-resends terminal.subscribe on reconnect.
    // Keep the current xterm visible while the binary snapshot hydrates,
    // instead of clearing to a blank "Loading terminals" surface.
    if (initializedHandlesRef.current.size === 0) {
      setTerminalsLoaded(false)
    }
    // Why: on reconnect the RPC client auto-resends terminal.subscribe and
    // the server sends a fresh scrollback frame. The subscribe handler drops
    // scrollback when initializedHandlesRef already contains the handle, so
    // we'd keep stale pre-disconnect content (and lose any output emitted
    // during the disconnect). Clear the flag so the fresh snapshot calls
    // ref.init(...) and replaces the buffer.
    initializedHandlesRef.current.clear()
    let disposed = false
    const timers: ReturnType<typeof setTimeout>[] = []
    function addTimer(fn: () => void, ms: number) {
      if (disposed) {
        return
      }
      timers.push(setTimeout(fn, ms))
    }
    void (async () => {
      if (client && created !== '1') {
        // Why: desktop reveal can be slow on cold/busy hosts, but mobile
        // session tabs are addressed by worktree id and can load immediately.
        void client
          .sendRequest('worktree.activate', {
            worktree: `id:${worktreeId}`
          })
          .catch(() => null)
      }
      if (disposed) {
        return
      }
      await fetchSessionTabs().catch(() => null)
      if (disposed) {
        return
      }
      await fetchTerminals({ allowEmptyLoaded: false })
      if (disposed) {
        return
      }
      addTimer(() => void fetchTerminals({ allowEmptyLoaded: false }), 750)
      addTimer(() => void fetchTerminals({ allowEmptyLoaded: true }), 1500)
      if (client && created === '1') {
        addTimer(() => {
          if (activeHandleRef.current) {
            return
          }
          void (async () => {
            await client
              .sendRequest('worktree.activate', {
                worktree: `id:${worktreeId}`
              })
              .catch(() => null)
            if (disposed) {
              return
            }
            await fetchTerminals({ allowEmptyLoaded: true })
            addTimer(() => void fetchTerminals({ allowEmptyLoaded: true }), 750)
          })()
        }, 1800)
      }
    })()
    return () => {
      disposed = true
      for (const t of timers) {
        clearTimeout(t)
      }
    }
  }, [client, connState, created, fetchSessionTabs, fetchTerminals, worktreeId])

  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    const unsubscribe = client.subscribe(
      'session.tabs.subscribe',
      { worktree: `id:${worktreeId}` },
      (payload) => {
        const event = payload as { type?: string } & SessionTabsResult
        if (event.type === 'snapshot' || event.type === 'updated') {
          applySessionTabs(event)
          const activeMarkdown = event.tabs.find(
            (tab): tab is Extract<MobileSessionTab, { type: 'markdown' }> =>
              tab.type === 'markdown' && tab.isActive
          )
          if (activeMarkdown) {
            setMarkdownDocs((prev) => {
              const current = prev.get(activeMarkdown.id)
              if (current?.status === 'ready' && activeMarkdown.isDirty && !current.isDirty) {
                const next = new Map(prev)
                next.set(activeMarkdown.id, { ...current, stale: true })
                return next
              }
              return prev
            })
          }
        }
      }
    )
    return () => unsubscribe()
  }, [applySessionTabs, client, connState, worktreeId])

  useFocusEffect(
    useCallback(() => {
      if (connState !== 'connected') {
        return
      }
      void fetchSessionTabs()
      void fetchTerminals()
      // Why: the live tab subscription stays mounted for stream ownership,
      // but the fallback list poll should stop while this route is hidden.
      const interval = setInterval(() => {
        void fetchSessionTabs()
        void fetchTerminals()
      }, 2000)
      return () => clearInterval(interval)
    }, [connState, fetchSessionTabs, fetchTerminals])
  )

  // Why: pick up the Settings → Terminal text size when returning here — the
  // terminal panes stay mounted, so they update in place.
  useFocusEffect(
    useCallback(() => {
      let active = true
      void loadTerminalTextScale().then((scale) => {
        if (active) {
          setTerminalTextScale(scale)
        }
      })
      return () => {
        active = false
      }
    }, [])
  )

  // Why: pick up the Settings → Terminal autocomplete toggle when returning here.
  useFocusEffect(
    useCallback(() => {
      let active = true
      void loadTerminalAutocompleteEnabled().then((enabled) => {
        if (active) {
          setAutocompleteEnabled(enabled)
        }
      })
      return () => {
        active = false
      }
    }, [])
  )

  // Why: link routing is a phone-local choice; reload after Settings → Browser.
  useFocusEffect(
    useCallback(() => {
      let active = true
      void loadTerminalLinkOpenMode().then((mode) => {
        if (active) {
          setTerminalLinkOpenMode(mode)
        }
      })
      return () => {
        active = false
      }
    }, [])
  )

  // Why: unsubscribe the old terminal so the server restores its desktop dims
  // (clearing the phone-fit banner), then subscribe the new terminal with the
  // measured viewport so the server phone-fits it. Also call terminal.focus
  // so the desktop renderer follows the mobile user's active terminal.
  const switchTab = useCallback(
    (handle: string) => {
      triggerSelection()
      const matchingTab = sessionTabs.find(
        (tab): tab is Extract<MobileSessionTab, { type: 'terminal' }> =>
          tab.type === 'terminal' && tab.terminal === handle
      )
      pendingActiveSessionTabIdRef.current = matchingTab?.id ?? null
      pendingActiveTerminalHandleRef.current = handle
      activeSessionTabTypeRef.current = 'terminal'
      setActiveSessionTabId(matchingTab?.id ?? null)
      const prev = activeHandleRef.current
      activeHandleRef.current = handle
      setActiveHandle(handle)
      if (prev && prev !== handle) {
        unsubscribeTerminal(prev)
        initializedHandlesRef.current.delete(prev)
      }
      // Force a fresh subscribe even if eagerly subscribed without viewport
      if (terminalUnsubsRef.current.has(handle)) {
        unsubscribeTerminal(handle)
        initializedHandlesRef.current.delete(handle)
      }
      subscribeToTerminal(handle)
      if (client) {
        void client.sendRequest('terminal.focus', { terminal: handle }).catch(() => {})
        if (matchingTab) {
          void client
            .sendRequest('session.tabs.activate', {
              worktree: `id:${worktreeId}`,
              tabId: matchingTab.id
            })
            .catch(() => {})
        }
      }
    },
    [client, sessionTabs, subscribeToTerminal, unsubscribeTerminal, worktreeId]
  )

  const switchSessionTab = useCallback(
    (tab: MobileSessionTab) => {
      if (tab.type === 'terminal') {
        if (typeof tab.terminal === 'string') {
          switchTab(tab.terminal)
          return
        }
        triggerSelection()
        pendingActiveSessionTabIdRef.current = tab.id
        pendingActiveTerminalHandleRef.current = null
        activeSessionTabTypeRef.current = 'terminal'
        setActiveSessionTabId(tab.id)
        const prev = activeHandleRef.current
        if (prev) {
          unsubscribeTerminal(prev)
          initializedHandlesRef.current.delete(prev)
        }
        activeHandleRef.current = null
        setActiveHandle(null)
        if (client) {
          void client
            .sendRequest('session.tabs.activate', {
              worktree: `id:${worktreeId}`,
              tabId: tab.id
            })
            .catch(() => {})
        }
        return
      }

      triggerSelection()
      pendingActiveSessionTabIdRef.current = tab.id
      pendingActiveTerminalHandleRef.current = null
      activeSessionTabTypeRef.current = tab.type
      setActiveSessionTabId(tab.id)
      const prev = activeHandleRef.current
      if (prev) {
        unsubscribeTerminal(prev)
        initializedHandlesRef.current.delete(prev)
      }
      activeHandleRef.current = null
      setActiveHandle(null)
      if (client) {
        void client
          .sendRequest('session.tabs.activate', {
            worktree: `id:${worktreeId}`,
            tabId: tab.id
          })
          .catch(() => {})
      }
      if (tab.type === 'browser') {
        return
      }
      if (tab.type === 'file') {
        void readFileTab(tab)
        return
      }
      const cached = markdownDocs.get(tab.id)
      if (cached?.status === 'ready' && cached.isDirty) {
        return
      }
      // Why: desktop clean saves do not carry a reliable content version in the
      // lightweight tab list. Re-read on revisit unless the phone has a draft.
      void readMarkdownTab(tab)
    },
    [client, markdownDocs, readFileTab, readMarkdownTab, switchTab, unsubscribeTerminal, worktreeId]
  )
  // Keep the ref pointing at the latest switchSessionTab so fetchSessionTabs can
  // activate a freshly-synced browser tab without a callback dependency cycle.
  switchSessionTabRef.current = switchSessionTab

  // Why: just store the ref. Subscription is deferred to handleTerminalWebReady
  // which fires after the WebView has loaded xterm.js and is ready to process
  // init messages. This prevents the blank terminal race where init() was
  // queued before the WebView loaded.
  const setTerminalWebViewRef = useCallback((handle: string, ref: TerminalWebViewHandle | null) => {
    if (ref) {
      terminalRefs.current.set(handle, ref)
    } else {
      terminalRefs.current.delete(handle)
      terminalGestureInputBucketsRef.current.delete(handle)
      const queued = terminalGestureInputQueuesRef.current.get(handle)
      if (queued?.timer) {
        clearTimeout(queued.timer)
      }
      terminalGestureInputQueuesRef.current.delete(handle)
      terminalGestureInputInFlightRef.current.delete(handle)
    }
  }, [])

  const handleTerminalWebReady = useCallback(
    (handle: string) => {
      const wasAlreadyReady = webReadyHandlesRef.current.has(handle)
      webReadyHandlesRef.current.add(handle)
      if (wasAlreadyReady && initializedHandlesRef.current.has(handle)) {
        // Why: the native WebView reloaded (Metro hot reload or Android
        // process churn). The old xterm buffer is gone, so force a fresh
        // scrollback snapshot. Only resubscribe if this is a reload — on
        // first load the subscription is already running and pendingMessages
        // will flush the queued init after this callback returns.
        // (unsubscribeTerminal also clears layoutSeqRef for this handle.)
        unsubscribeTerminal(handle)
        initializedHandlesRef.current.delete(handle)
        if (handle === activeHandleRef.current) {
          subscribeToTerminal(handle)
        }
        return
      }
      // Why: on first web-ready, the initial subscribeToTerminal call from
      // fetchTerminals may have been skipped (reason=no-ref, WebView wasn't
      // mounted yet). Now that the WebView is ready, subscribe if this is the
      // active terminal and no subscription is running. Await measure before
      // subscribe so the very first subscribe carries the viewport — without
      // this, subscribe(viewport=null) lands on the server first and the
      // post-scrollback measure path's resubscribe sees alreadyMeasured=true
      // (because measureViewportOnce won the race) and silently skips.
      if (handle === activeHandleRef.current && !terminalUnsubsRef.current.has(handle)) {
        void (async () => {
          await measureViewportOnce(handle)
          if (handle === activeHandleRef.current && !terminalUnsubsRef.current.has(handle)) {
            subscribeToTerminal(handle)
          }
        })()
      }
    },
    [measureViewportOnce, subscribeToTerminal, unsubscribeTerminal]
  )

  useEffect(() => {
    if (activeSessionTab?.type !== 'markdown') {
      return
    }
    const doc = markdownDocs.get(activeSessionTab.id)
    if (!doc) {
      void readMarkdownTab(activeSessionTab)
    }
  }, [activeSessionTab, markdownDocs, readMarkdownTab])

  useEffect(() => {
    if (activeSessionTab?.type !== 'file') {
      return
    }
    const doc = fileDocs.get(activeSessionTab.id)
    if (!doc) {
      void readFileTab(activeSessionTab)
    }
  }, [activeSessionTab, fileDocs, readFileTab])

  async function handleSend() {
    if (!client || !activeHandle || sendingRef.current) {
      return
    }
    sendingRef.current = true

    const text = normalizeTerminalTextInput(input)
    setInput('')

    try {
      await client.sendRequest('terminal.send', {
        terminal: activeHandle,
        text,
        enter: true,
        // Why: presence-lock take-floor signal. Identifies this phone as
        // the active mobile actor so the runtime can resolve multi-mobile
        // contention (most-recent-actor's viewport wins).
        ...(deviceTokenRef.current
          ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
          : {})
      })
    } catch {
      setInput(text)
    } finally {
      sendingRef.current = false
    }
  }

  async function handleAccessoryKey(bytes: string) {
    if (!client || !activeHandle || !canSend) {
      return
    }

    try {
      await client.sendRequest('terminal.send', {
        terminal: activeHandle,
        text: bytes,
        enter: false,
        ...(deviceTokenRef.current
          ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
          : {})
      })
    } catch {
      // Transient failure
    }
  }

  const sendLiveTerminalInput = useCallback(
    (handle: string, bytes: string) => {
      const text = normalizeTerminalTextInput(bytes)
      if (text.length === 0) {
        return
      }
      if (!isTerminalLiveInputWithinByteLimit(text)) {
        triggerError()
        showToast('Input too large (max 256 KiB)', 1500)
        return
      }
      const rpc = clientRef.current
      if (
        !rpc ||
        connStateRef.current !== 'connected' ||
        handle !== activeHandleRef.current ||
        activeSessionTabTypeRef.current !== 'terminal'
      ) {
        return
      }
      void rpc
        .sendRequest('terminal.send', {
          terminal: handle,
          text,
          enter: false,
          ...(deviceTokenRef.current
            ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
            : {})
        })
        .catch(() => {
          // Transient failure
        })
    },
    [showToast]
  )

  const focusLiveInput = useCallback(() => {
    if (!canSend || !liveInputEnabled) {
      return
    }
    liveInputRef.current?.focus()
  }, [canSend, liveInputEnabled])

  const handleTerminalTap = useCallback(
    (handle: string) => {
      if (handle !== activeHandleRef.current) {
        return
      }
      focusLiveInput()
    },
    [focusLiveInput]
  )

  // Tap on a file path in terminal output → resolve it on the host and open it
  // as a file tab (mirrors desktop Cmd/Ctrl-click). Silent on a miss; the
  // WebView only emits this when the tap landed on a detected path.
  const handleFileTap = useCallback(
    (handle: string, pathText: string) => {
      if (handle !== activeHandleRef.current || !client) {
        return
      }
      void (async () => {
        try {
          const worktree = `id:${worktreeId}`
          const response = await client.sendRequest(
            'files.resolveTerminalPath',
            { worktree, pathText },
            { timeoutMs: 10_000 }
          )
          if (!response.ok) {
            return
          }
          const resolved = (response as RpcSuccess).result as RuntimeTerminalPathResolution
          if (!resolved.exists || resolved.isDirectory || !resolved.relativePath) {
            return
          }
          // Confirm the tap landed on something openable before giving feedback.
          triggerSelection()
          // Why: HTML opens in a browser pane (streamed from the desktop),
          // matching desktop's terminal-click behavior, instead of a file view.
          if (classifyMobileArtifact(resolved.relativePath) === 'html' && resolved.absolutePath) {
            void handleCreateBrowser('file://' + resolved.absolutePath)
            return
          }
          const openResponse = await client.sendRequest(
            'files.open',
            { worktree, relativePath: resolved.relativePath },
            { timeoutMs: 15_000 }
          )
          if (!openResponse.ok) {
            return
          }
          // Why: the host opens the file as a markdown/file/image tab (the type
          // depends on the file — .md opens as a 'markdown' tab), and from a terminal
          // the active tab stays on the terminal. Once the new tab syncs in, switch to
          // it by relativePath across ANY openable type. Poll since it arrives async.
          const openedPath = resolved.relativePath
          // Why: retries poll for the async-arriving tab, but once activation lands
          // a later retry would steal focus back from the user — short-circuit the
          // remaining ones once the opened tab is (or becomes) the active tab.
          let activated = false
          const activateOpenedTab = async (): Promise<void> => {
            if (activated) {
              return
            }
            await fetchSessionTabs()
            if (activated) {
              return
            }
            const opened = sessionTabsRef.current.find(
              (tab): tab is Extract<MobileSessionTab, { relativePath?: string }> =>
                'relativePath' in tab && tab.relativePath === openedPath
            )
            if (!opened) {
              return
            }
            if (activeSessionTabIdRef.current === opened.id) {
              activated = true
              return
            }
            switchSessionTabRef.current?.(opened)
            activated = true
          }
          scheduleDelayedAction(() => void activateOpenedTab(), 300)
          scheduleDelayedAction(() => void activateOpenedTab(), 900)
          scheduleDelayedAction(() => void activateOpenedTab(), 1800)
        } catch {
          // Resolution/open is best-effort; a failed tap silently no-ops.
        }
      })()
    },
    [client, worktreeId, scheduleDelayedAction, fetchSessionTabs]
  )

  const handleTerminalOpenUrl = useCallback(
    (handle: string, url: string) => {
      if (handle !== activeHandleRef.current) {
        return
      }
      if (terminalLinkOpenMode === 'phone-browser') {
        void Linking.openURL(url).catch(() => {})
        return
      }
      void handleCreateBrowserRef.current?.(url)
    },
    [terminalLinkOpenMode]
  )

  const toggleLiveInput = useCallback(() => {
    if (!activeHandle) {
      return
    }
    const nextEnabled = !liveInputTerminalHandles.has(activeHandle)
    setLiveInputTerminalHandles((prev) => {
      const next = new Set(prev)
      if (nextEnabled) {
        next.add(activeHandle)
      } else {
        next.delete(activeHandle)
      }
      return next
    })
    setLiveInputCapture('')
    if (nextEnabled) {
      scheduleTerminalLiveInputFocus(liveInputFocusTimerRef, () => liveInputRef.current?.focus())
    } else {
      clearTerminalLiveInputFocusTimer(liveInputFocusTimerRef)
      liveInputRef.current?.blur()
    }
  }, [activeHandle, liveInputTerminalHandles])

  const handleLiveInputChange = useCallback(
    (text: string) => {
      if (!activeHandle) {
        setLiveInputCapture('')
        liveInputRef.current?.setNativeProps({ text: '' })
        return
      }
      if (!liveInputTerminalHandles.has(activeHandle)) {
        setLiveInputCapture('')
        liveInputRef.current?.setNativeProps({ text: '' })
        return
      }
      const normalizedText = normalizeTerminalTextInput(text)
      if (normalizedText.length > 0) {
        sendLiveTerminalInput(activeHandle, normalizedText)
      }
      setLiveInputCapture('')
      // Why: the field is only a keyboard capture surface. Clearing the
      // native value prevents subsequent phone-keyboard events from replaying
      // already-sent characters when React state remains the empty string.
      liveInputRef.current?.setNativeProps({ text: '' })
    },
    [activeHandle, liveInputTerminalHandles, sendLiveTerminalInput]
  )

  const handleLiveInputKeyPress = useCallback(
    (event: { nativeEvent: { key: string } }) => {
      if (!activeHandle) {
        return
      }
      if (!liveInputTerminalHandles.has(activeHandle)) {
        return
      }
      const bytes = getTerminalLiveSpecialKeyBytes(event.nativeEvent.key)
      if (!bytes) {
        return
      }
      sendLiveTerminalInput(activeHandle, bytes)
      setLiveInputCapture('')
      liveInputRef.current?.setNativeProps({ text: '' })
    },
    [activeHandle, liveInputTerminalHandles, sendLiveTerminalInput]
  )

  const handleLiveInputSubmit = useCallback(() => {
    if (!activeHandle) {
      return
    }
    if (!liveInputTerminalHandles.has(activeHandle)) {
      return
    }
    sendLiveTerminalInput(activeHandle, '\r')
    setLiveInputCapture('')
    liveInputRef.current?.setNativeProps({ text: '' })
  }, [activeHandle, liveInputTerminalHandles, sendLiveTerminalInput])

  const allowTerminalGestureInput = useCallback(
    (handle: string, sequenceCount: number): boolean => {
      const now = Date.now()
      const current = terminalGestureInputBucketsRef.current.get(handle) ?? {
        tokens: TERMINAL_GESTURE_INPUT_BUCKET_CAPACITY,
        lastRefillMs: now
      }
      const elapsedSeconds = Math.max(0, now - current.lastRefillMs) / 1000
      const tokens = Math.min(
        TERMINAL_GESTURE_INPUT_BUCKET_CAPACITY,
        current.tokens + elapsedSeconds * TERMINAL_GESTURE_INPUT_REFILL_PER_SECOND
      )

      // Why: tokens represent terminal control sequences, not WebView messages;
      // one legitimate gesture message may batch up to 32 wheel/key reports.
      if (tokens < sequenceCount) {
        terminalGestureInputBucketsRef.current.set(handle, { tokens, lastRefillMs: now })
        return false
      }

      terminalGestureInputBucketsRef.current.set(handle, {
        tokens: tokens - sequenceCount,
        lastRefillMs: now
      })
      return true
    },
    []
  )

  const flushTerminalGestureInput = useCallback(async (handle: string) => {
    const queued = terminalGestureInputQueuesRef.current.get(handle)
    if (!queued) {
      return
    }
    if (queued.timer) {
      clearTimeout(queued.timer)
      queued.timer = null
    }
    if (terminalGestureInputInFlightRef.current.has(handle)) {
      return
    }

    terminalGestureInputQueuesRef.current.delete(handle)
    const isActive =
      handle === activeHandleRef.current && activeSessionTabTypeRef.current === 'terminal'
    const isFresh = Date.now() - queued.lastUpdatedMs <= TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS
    const rpc = clientRef.current
    if (!rpc || connStateRef.current !== 'connected' || !isActive || !isFresh) {
      return
    }

    terminalGestureInputInFlightRef.current.add(handle)
    try {
      await rpc.sendRequest('terminal.send', {
        terminal: handle,
        text: queued.bytes,
        enter: false,
        ...(deviceTokenRef.current
          ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
          : {})
      })
    } catch {
      // Transient failure
    } finally {
      terminalGestureInputInFlightRef.current.delete(handle)
      const next = terminalGestureInputQueuesRef.current.get(handle)
      if (next) {
        if (Date.now() - next.lastUpdatedMs > TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS) {
          if (next.timer) {
            clearTimeout(next.timer)
          }
          terminalGestureInputQueuesRef.current.delete(handle)
        } else {
          void flushTerminalGestureInput(handle)
        }
      }
    }
  }, [])

  const enqueueTerminalGestureInput = useCallback(
    (handle: string, bytes: string, sequenceCount: number) => {
      const now = Date.now()
      const current = terminalGestureInputQueuesRef.current.get(handle)
      if (
        current &&
        current.sequenceCount + sequenceCount <= TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES
      ) {
        current.bytes += bytes
        current.sequenceCount += sequenceCount
        current.lastUpdatedMs = now
        return
      }

      if (current) {
        if (current.timer) {
          clearTimeout(current.timer)
        }
        if (!terminalGestureInputInFlightRef.current.has(handle)) {
          void flushTerminalGestureInput(handle)
        } else {
          // Why: an RPC is in-flight and the new batch would overflow the
          // pending-sequences cap. Appending preserves the already-queued
          // bytes (which would otherwise be dropped) — the in-flight flush's
          // finally block will pick up the merged queue. The cap is a soft
          // guideline; brief overflow during in-flight is preferable to
          // silently dropping user input.
          current.bytes += bytes
          current.sequenceCount += sequenceCount
          current.lastUpdatedMs = now
          current.timer = setTimeout(() => {
            current.timer = null
            void flushTerminalGestureInput(handle)
          }, TERMINAL_GESTURE_INPUT_FLUSH_DELAY_MS)
          return
        }
      }

      const queued: TerminalGestureInputQueue = {
        bytes,
        sequenceCount,
        timer: null,
        lastUpdatedMs: now
      }
      queued.timer = setTimeout(() => {
        queued.timer = null
        void flushTerminalGestureInput(handle)
      }, TERMINAL_GESTURE_INPUT_FLUSH_DELAY_MS)
      terminalGestureInputQueuesRef.current.set(handle, queued)
    },
    [flushTerminalGestureInput]
  )

  const handleTerminalInput = useCallback(
    async (handle: string, bytes: string) => {
      if (!client || connState !== 'connected' || bytes.length === 0) {
        return
      }
      if (handle !== activeHandleRef.current || activeSessionTabTypeRef.current !== 'terminal') {
        return
      }
      const modes = ptyModesRef.current.get(handle)
      // Why: WebView gesture bytes can become PTY input here, so mouse-aware
      // reports stay behind validation and SSH-safe rate limiting.
      if (!modes?.altScreen && !isGestureMouseTrackingMode(modes?.mouseTrackingMode)) {
        return
      }
      const sequenceCount = countTerminalGestureInputSequences(bytes)
      if (sequenceCount == null) {
        return
      }
      if (!allowTerminalGestureInput(handle, sequenceCount)) {
        return
      }
      enqueueTerminalGestureInput(handle, bytes, sequenceCount)
    },
    [allowTerminalGestureInput, client, connState, enqueueTerminalGestureInput]
  )

  async function handleClearTerminal(target: Terminal) {
    if (!client) {
      return
    }
    getTerminalRef(target.handle)?.clear()
    try {
      await client.sendRequest('terminal.clearBuffer', {
        terminal: target.handle
      })
      showToast('Terminal cleared')
    } catch {
      showToast("Couldn't clear terminal", 1500)
    }
  }

  // Why: press-and-hold key repeat for keys flagged repeatable (arrows,
  // backspace, forward-delete). Matches iOS keyboard cadence: instant first
  // fire, then ~400ms before the second, then ~45ms between subsequent
  // repeats. Non-repeatable keys (Tab, Esc, Ctrl-*) intentionally fire once
  // because holding them is destructive or meaningless.
  const repeatTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Why: hold the latest handleAccessoryKey in a ref so the repeat interval
  // always invokes the current callback. Otherwise a held key keeps firing
  // through the callback captured when the interval started, which can route
  // bytes to a stale terminal/RPC client after a tab switch or reconnect
  // mid-hold.
  const handleAccessoryKeyRef = useRef(handleAccessoryKey)
  handleAccessoryKeyRef.current = handleAccessoryKey
  const stopAccessoryRepeat = useCallback(() => {
    if (repeatTimeoutRef.current) {
      clearTimeout(repeatTimeoutRef.current)
      repeatTimeoutRef.current = null
    }
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current)
      repeatIntervalRef.current = null
    }
  }, [])
  const startAccessoryRepeat = useCallback(
    (bytes: string) => {
      stopAccessoryRepeat()
      repeatTimeoutRef.current = setTimeout(() => {
        repeatIntervalRef.current = setInterval(() => {
          void handleAccessoryKeyRef.current(bytes)
        }, 45)
      }, 400)
    },
    [stopAccessoryRepeat]
  )
  const setMobileSessionRootRef = useCallback(
    (node: View | null): void => {
      if (node !== null) {
        return
      }
      // Why: terminal subscriptions and route-level timers must clear only on
      // real route detach; client churn during mount can otherwise wipe xterm
      // state mid-subscribe.
      toastSeqRef.current += 1
      clearTerminalCache()
      clearToastHideTimer()
      clearDelayedActionTimers()
      clearTerminalLiveInputFocusTimer(liveInputFocusTimerRef)
      stopAccessoryRepeat()
    },
    [clearDelayedActionTimers, clearTerminalCache, clearToastHideTimer, stopAccessoryRepeat]
  )

  const handleSelectionMode = useCallback((handle: string, active: boolean) => {
    if (handle !== activeHandleRef.current) {
      return
    }
    setSelectModeActive(active)
    if (active) {
      Keyboard.dismiss()
    }
  }, [])

  const handleSelectionCopy = useCallback(
    async (handle: string, text: string) => {
      if (handle !== activeHandleRef.current) {
        return
      }
      if (!text || text.length === 0) {
        terminalRefs.current.get(handle)?.cancelSelect()
        return
      }
      try {
        await Clipboard.setStringAsync(text)
        triggerSuccess()
        // Why: Android 13+ shows its own system "Copied to clipboard" toast on
        // every clipboard write, so our toast would be redundant; iOS shows
        // nothing on copy (it only banners on paste), so the in-app toast is
        // the only success signal there.
        if (Platform.OS === 'ios') {
          showToast('Copied')
        }
        terminalRefs.current.get(handle)?.cancelSelect()
      } catch (e) {
        triggerError()
        const err = e as { name?: string; message?: string }
        // eslint-disable-next-line no-console
        console.warn('[mobile-clip] setString failed', {
          name: err.name,
          message: err.message
        })
        showToast("Couldn't copy", 1500)
      }
    },
    [showToast]
  )

  const handleSelectionEvicted = useCallback(
    (handle: string) => {
      if (handle !== activeHandleRef.current) {
        return
      }
      // eslint-disable-next-line no-console
      console.warn('[mobile-clip] selection evicted')
      showToast('Selection cleared (scrolled out of buffer)', 1500)
      setSelectModeActive(false)
    },
    [showToast]
  )

  const handleModesChanged = useCallback((handle: string, modes: TerminalModes) => {
    ptyModesRef.current.set(handle, modes)
    initialModesSeenRef.current.add(handle)
  }, [])

  const handleKeyboardAvoidanceMetrics = useCallback(
    (handle: string, metrics: TerminalKeyboardAvoidanceMetrics) => {
      setTerminalKeyboardMetrics((prev) => {
        const current = prev.get(handle)
        if (
          current &&
          current.cursorY === metrics.cursorY &&
          current.rows === metrics.rows &&
          current.altScreen === metrics.altScreen
        ) {
          return prev
        }
        return new Map(prev).set(handle, metrics)
      })
    },
    []
  )

  const handleHaptic = useCallback((kind: 'selection' | 'success' | 'error' | 'edge-bump') => {
    if (kind === 'selection') {
      triggerSelection()
    } else if (kind === 'success') {
      triggerSuccess()
    } else if (kind === 'error') {
      triggerError()
    } else if (kind === 'edge-bump') {
      triggerEdgeBump()
    }
  }, [])

  const getActiveWorktreeConnectionId = useCallback(async (): Promise<string | null> => {
    if (!client) {
      return null
    }
    const repoId = getRepoIdFromMobileWorktreeId(worktreeId)
    const repoResponse = await client.sendRequest('repo.list')
    if (!repoResponse.ok) {
      throw new Error((repoResponse as RpcFailure).error.message)
    }
    const repos =
      ((repoResponse as RpcSuccess).result as { repos?: RuntimeRepoSummary[] }).repos ?? []
    return repos.find((repo) => repo.id === repoId)?.connectionId?.trim() || null
  }, [client, worktreeId])

  const refreshCanPaste = useCallback(() => {
    void Promise.all([
      Clipboard.hasStringAsync().catch(() => false),
      Clipboard.hasImageAsync().catch(() => false)
    ]).then(([hasString, hasImage]) => {
      setCanPaste(hasString || hasImage)
    })
  }, [])

  const handlePaste = useCallback(async () => {
    if (!client || !activeHandle || !canSend) {
      return
    }
    try {
      const text = await Clipboard.getStringAsync()
      let payload: string | null = null
      if (text.length > 0) {
        const modes = ptyModesRef.current.get(activeHandle) || {
          bracketedPasteMode: false,
          altScreen: false,
          mouseTrackingMode: 'none',
          sgrMouseMode: false,
          sgrMousePixelsMode: false
        }
        const wrap = modes.bracketedPasteMode && !modes.altScreen
        // Why: strip embedded bracketed-paste markers from clipboard text so a
        // malicious copy containing `\x1b[201~` can't terminate paste mode early
        // and have the trailing bytes interpreted as shell commands. Matches
        // xterm.js / iTerm2 behavior.
        // eslint-disable-next-line no-control-regex -- intentional bracketed-paste marker stripping
        const sanitized = wrap ? text.replace(/\x1b\[20[01]~/g, '') : text
        payload = wrap ? `\x1b[200~${sanitized}\x1b[201~` : sanitized
      } else {
        const image = await Clipboard.getImageAsync({ format: 'png' })
        if (!image) {
          refreshCanPaste()
          return
        }
        const connectionId = await getActiveWorktreeConnectionId()
        const imagePath = await saveMobileClipboardImageAsTempFile(client, image.data, {
          connectionId
        })
        payload = buildMobileImagePastePayload(imagePath)
      }

      const wrappedBytes = new TextEncoder().encode(payload).byteLength
      if (wrappedBytes > 256 * 1024) {
        triggerError()
        // eslint-disable-next-line no-console
        console.warn('[mobile-clip] paste oversized', { wrappedBytes })
        showToast('Paste too large (max 256 KiB)', 1500)
        return
      }
      await client.sendRequest('terminal.send', {
        terminal: activeHandle,
        text: payload,
        enter: false,
        ...(deviceTokenRef.current
          ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
          : {})
      })
      triggerSelection()
      refreshCanPaste()
    } catch (e) {
      triggerError()
      const err = e as { name?: string; message?: string }
      const isDisconnected = connState !== 'connected'
      // eslint-disable-next-line no-console
      console.warn('[mobile-clip] paste failed', { name: err.name, message: err.message })
      if (isDisconnected) {
        showToast('Paste failed (disconnected)', 1500)
      } else if (err.message === 'Clipboard image is too large') {
        showToast('Image too large to paste', 1500)
      } else {
        showToast('Paste failed', 1500)
      }
    }
  }, [
    client,
    activeHandle,
    canSend,
    connState,
    getActiveWorktreeConnectionId,
    refreshCanPaste,
    showToast
  ])

  const { attachImage, isAttaching } = useMobileImageAttachment({
    client,
    activeHandle,
    canSend,
    connState,
    deviceTokenRef,
    getActiveWorktreeConnectionId,
    showToast,
    onSuccess: triggerSelection,
    onError: triggerError
  })

  // Why: refresh canPaste on mount, AppState active, after paste.
  useEffect(() => {
    let mounted = true
    const refresh = () => {
      void Promise.all([
        Clipboard.hasStringAsync().catch(() => false),
        Clipboard.hasImageAsync().catch(() => false)
      ]).then(([hasString, hasImage]) => {
        if (mounted) {
          setCanPaste(hasString || hasImage)
        }
      })
    }
    refresh()
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') {
        refresh()
      } else if (selectModeActive && activeHandleRef.current) {
        terminalRefs.current.get(activeHandleRef.current)?.cancelSelect()
      }
    })
    return () => {
      mounted = false
      sub.remove()
    }
  }, [selectModeActive])

  useEffect(() => {
    const shouldLoadAgentOptions = showCreateTabDrawer || pendingDiffNotesDelivery !== null
    if (!shouldLoadAgentOptions) {
      setCreateTabAgentLoadState('idle')
      setCreateTabAgentOptions([])
      return
    }
    if (!client || connState !== 'connected') {
      setCreateTabAgentLoadState('idle')
      setCreateTabAgentOptions([])
      return
    }

    let stale = false
    setCreateTabAgentLoadState('loading')
    setCreateTabAgentOptions([])

    void (async () => {
      const [settingsResponse, repoResponse] = await Promise.all([
        client.sendRequest('settings.get'),
        client.sendRequest('repo.list')
      ])
      if (!settingsResponse.ok) {
        throw new Error((settingsResponse as RpcFailure).error.message)
      }
      const settings = (
        (settingsResponse as RpcSuccess).result as {
          settings?: MobileNewTabAgentSettings
        }
      ).settings
      if (!repoResponse.ok) {
        throw new Error((repoResponse as RpcFailure).error.message)
      }
      const repoId = getRepoIdFromMobileWorktreeId(worktreeId)
      if (!repoId) {
        throw new Error('worktree_repo_missing')
      }
      const repos =
        ((repoResponse as RpcSuccess).result as { repos?: RuntimeRepoSummary[] }).repos ?? []
      const repo = repos.find((candidate) => candidate.id === repoId)
      if (!repo) {
        throw new Error('worktree_repo_not_found')
      }
      const connectionId = repo.connectionId?.trim() || null
      const detectedResponse = connectionId
        ? await client.sendRequest('preflight.detectRemoteAgents', { connectionId })
        : await client.sendRequest('preflight.detectAgents')
      if (!detectedResponse.ok) {
        throw new Error((detectedResponse as RpcFailure).error.message)
      }
      if (stale) {
        return
      }
      const detectedAgentIds = (detectedResponse as RpcSuccess).result as unknown[]
      setCreateTabAgentOptions(buildMobileNewTabAgentOptions(settings, detectedAgentIds))
      setCreateTabAgentLoadState('loaded')
    })().catch(() => {
      if (!stale) {
        setCreateTabAgentOptions([])
        setCreateTabAgentLoadState('error')
      }
    })

    return () => {
      stale = true
    }
  }, [client, connState, pendingDiffNotesDelivery, showCreateTabDrawer, worktreeId])

  async function handleCreateTerminal(
    agent?: MobileNewTabAgentOption['agent'],
    options?: { initialPrompt?: string; onPromptSent?: () => void }
  ) {
    if (!client || creating) {
      return
    }

    setCreating(true)
    setCreateError('')

    try {
      const response = await client.sendRequest('session.tabs.createTerminal', {
        worktree: `id:${worktreeId}`,
        afterTabId: activeSessionTabId ?? undefined,
        ...(agent ? { agent } : {})
      })
      if (response.ok) {
        const result = (response as RpcSuccess).result as TerminalCreateResult
        const created = result.tab
        // Why: unsubscribe the old active terminal so the server restores its
        // desktop dims. Without this, the old terminal's mobile subscription
        // stays alive and its restore timer is never set.
        const prev = activeHandleRef.current
        if (prev) {
          unsubscribeTerminal(prev)
          initializedHandlesRef.current.delete(prev)
        }
        pendingActiveSessionTabIdRef.current = created.id
        activeSessionTabTypeRef.current = 'terminal'
        setActiveSessionTabId(created.id)
        setSessionTabs((prev) => {
          if (prev.some((tab) => tab.id === created.id)) {
            return prev
          }
          return [...prev, { ...created, isActive: true }]
        })
        if (typeof created.terminal === 'string') {
          const createdHandle = created.terminal
          activeHandleRef.current = createdHandle
          setActiveHandle(createdHandle)
          setTerminals((prev) => {
            const existing = prev.find((terminal) => terminal.handle === createdHandle)
            const createdTerminal: Terminal = {
              handle: createdHandle,
              title: created.title || existing?.title || 'Terminal',
              terminalTheme: created.terminalTheme ?? existing?.terminalTheme,
              isActive: true
            }
            if (existing) {
              const next = prev.map((terminal) =>
                terminal.handle === createdHandle ? { ...terminal, ...createdTerminal } : terminal
              )
              terminalsRef.current = next
              return terminalRecordsEqual(prev, next) ? prev : next
            }
            const next = [...prev, createdTerminal]
            terminalsRef.current = next
            return next
          })
          subscribeToTerminal(createdHandle)
          if (options?.initialPrompt?.trim()) {
            void client
              .sendRequest('terminal.send', {
                terminal: createdHandle,
                text: options.initialPrompt,
                enter: true,
                ...(deviceTokenRef.current
                  ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
                  : {})
              })
              .then((sendResponse) => {
                if (!sendResponse.ok) {
                  throw new Error(
                    (sendResponse as RpcFailure).error.message || 'Failed to send notes'
                  )
                }
                const result = (sendResponse as RpcSuccess).result as {
                  send?: { accepted?: boolean }
                }
                if (result.send?.accepted === false) {
                  throw new Error('Terminal input is locked by another client.')
                }
                triggerSuccess()
                showToast('Notes sent')
                options.onPromptSent?.()
              })
              .catch((err) => {
                triggerError()
                showToast(err instanceof Error ? err.message : "Couldn't send notes", 1800)
              })
          }
        } else {
          activeHandleRef.current = null
          setActiveHandle(null)
        }
        scheduleDelayedAction(() => void fetchSessionTabs(), 500)
      } else {
        setCreateError('Failed to create terminal')
      }
    } catch {
      setCreateError('Failed to create terminal')
    } finally {
      setCreating(false)
    }
  }

  async function handleCreateMarkdownNote() {
    if (!client || creatingMarkdown) {
      return
    }

    setCreatingMarkdown(true)
    setCreateError('')

    try {
      const worktree = `id:${worktreeId}`
      for (let attempt = 1; attempt <= 100; attempt += 1) {
        const relativePath = attempt === 1 ? 'untitled.md' : `untitled-${attempt}.md`
        const createResponse = await client.sendRequest(
          'files.createFile',
          { worktree, relativePath },
          { timeoutMs: 15_000 }
        )
        if (!createResponse.ok) {
          const message = (createResponse as RpcFailure).error.message
          if (isFileExistsErrorMessage(message) && attempt < 100) {
            continue
          }
          throw new Error(message || 'Failed to create markdown note')
        }

        const openResponse = await client.sendRequest(
          'files.open',
          { worktree, relativePath },
          { timeoutMs: 15_000 }
        )
        if (!openResponse.ok) {
          throw new Error((openResponse as RpcFailure).error.message)
        }
        scheduleDelayedAction(() => void fetchSessionTabs(), 300)
        return
      }
      throw new Error('Unable to create untitled markdown note')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create markdown note'
      setCreateError(message)
      showToast(message, 1800)
    } finally {
      setCreatingMarkdown(false)
    }
  }

  async function handleCreateBrowser(rawUrl = 'about:blank'): Promise<boolean> {
    if (!client || creatingBrowser) {
      return false
    }
    // Why: read via ref so a tap that fires before the capability probe resolves
    // (or from a stale callback) still sees the live support value.
    if (browserScreencastSupportedRef.current !== true) {
      showToast('Desktop update required for mobile browser streaming', 1600)
      return false
    }
    const url = normalizeBrowserUrl(rawUrl)
    if (!url) {
      const message = 'Enter a valid URL'
      setCreateError(message)
      showToast(message, 1400)
      return false
    }

    setCreatingBrowser(true)
    setCreateError('')
    try {
      const response = await client.sendRequest(
        'browser.tabCreate',
        {
          worktree: `id:${worktreeId}`,
          url,
          // The user opened this tab (tapped HTML / address bar) → focus it.
          activate: true
        },
        { timeoutMs: 30_000 }
      )
      if (!response.ok) {
        throw new Error((response as RpcFailure).error.message)
      }
      // Focus the new browser tab once it syncs (fetchSessionTabs activates it
      // via the normal path). Refresh a few times since the desktop registers
      // the tab asynchronously.
      const created = (response as RpcSuccess).result as { browserPageId?: string }
      if (created.browserPageId) {
        pendingBrowserFocusPageIdRef.current = created.browserPageId
      }
      void fetchSessionTabs()
      scheduleDelayedAction(() => void fetchSessionTabs(), 400)
      scheduleDelayedAction(() => void fetchSessionTabs(), 1200)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create browser'
      setCreateError(message)
      showToast(message, 1800)
      return false
    } finally {
      setCreatingBrowser(false)
    }
  }
  // Keep the ref pointing at the latest handleCreateBrowser so a terminal URL
  // tap (handleTerminalOpenUrl) always runs the current closure.
  handleCreateBrowserRef.current = handleCreateBrowser

  async function handleBrowserNavigationCommand(
    tab: Extract<MobileSessionTab, { type: 'browser' }>,
    method: 'browser.back' | 'browser.forward' | 'browser.reload'
  ) {
    if (!client || !tab.browserPageId) {
      showToast('Browser page is not available yet.', 1500)
      return
    }
    try {
      const response = await client.sendRequest(
        method,
        {
          worktree: `id:${worktreeId}`,
          page: tab.browserPageId
        },
        { timeoutMs: 15_000 }
      )
      if (!response.ok) {
        throw new Error((response as RpcFailure).error.message)
      }
      scheduleDelayedAction(() => void fetchSessionTabs(), 250)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Browser command failed'
      showToast(message, 1600)
    }
  }

  async function handleRenameTerminal(value: string) {
    if (!client || !renameTarget) {
      return
    }
    const target = renameTarget
    setRenameTarget(null)

    try {
      const title = value.trim()
      const response = await client.sendRequest('terminal.rename', {
        terminal: target.handle,
        title
      })
      if (response.ok) {
        setTerminals((prev) => {
          const next = prev.map((terminal) =>
            terminal.handle === target.handle
              ? { ...terminal, title: title || 'Terminal' }
              : terminal
          )
          terminalsRef.current = next
          return next
        })
        scheduleDelayedAction(() => void fetchTerminals(), 300)
      }
    } catch {
      // Rename failed — refresh will restore the server title.
    }
  }

  async function handleCloseTerminal(target: Terminal) {
    if (!client) {
      return
    }

    try {
      const response = await client.sendRequest('terminal.close', {
        terminal: target.handle
      })
      if (response.ok) {
        unsubscribeTerminal(target.handle)
        terminalRefs.current.delete(target.handle)
        initializedHandlesRef.current.delete(target.handle)
        const next = terminals.filter((terminal) => terminal.handle !== target.handle)
        setTerminals(next)
        terminalsRef.current = next
        if (activeHandleRef.current === target.handle) {
          const replacement = next[0] ?? null
          activeHandleRef.current = replacement?.handle ?? null
          pendingActiveTerminalHandleRef.current = replacement?.handle ?? null
          setActiveHandle(replacement?.handle ?? null)
          if (replacement) {
            subscribeToTerminal(replacement.handle)
          }
        }
        scheduleDelayedAction(() => void fetchTerminals(), 300)
      }
    } catch {
      // Close failed — keep the local tab list unchanged.
    }
  }

  async function handleCloseSessionTab(tab: MobileSessionTab) {
    if (!client) {
      return
    }
    try {
      const response = await client.sendRequest('session.tabs.close', {
        worktree: `id:${worktreeId}`,
        tabId: tab.id
      })
      if (response.ok) {
        if (tab.type === 'terminal' && typeof tab.terminal === 'string') {
          unsubscribeTerminal(tab.terminal)
          terminalRefs.current.delete(tab.terminal)
          initializedHandlesRef.current.delete(tab.terminal)
        }
        setSessionTabs((prev) => prev.filter((candidate) => candidate.id !== tab.id))
        if (activeSessionTabId === tab.id) {
          activeSessionTabTypeRef.current = null
          setActiveSessionTabId(null)
          activeHandleRef.current = null
          setActiveHandle(null)
        }
        scheduleDelayedAction(() => void fetchSessionTabs(), 300)
      }
    } catch {
      // Close failed — keep the authoritative session snapshot visible.
    }
  }

  const isPhoneMode = (handle: string | null): boolean => {
    if (!handle) {
      return false
    }
    const mode = terminalModes.get(handle)
    return mode === 'auto' || mode === 'phone' || mode === undefined
  }

  const visibleTabs: MobileSessionTab[] = sessionTabs
  const activeMarkdownTab = activeSessionTab?.type === 'markdown' ? activeSessionTab : null
  const activeFileTab = activeSessionTab?.type === 'file' ? activeSessionTab : null
  const activeBrowserTab = activeSessionTab?.type === 'browser' ? activeSessionTab : null
  const activePendingTerminalTab =
    activeSessionTab?.type === 'terminal' && typeof activeSessionTab.terminal !== 'string'
      ? activeSessionTab
      : null
  const showLoadingState = connState === 'connected' && !terminalsLoaded && visibleTabs.length === 0
  const showEmptyState =
    connState === 'connected' && terminalsLoaded && visibleTabs.length === 0 && !activeHandle

  useEffect(() => {
    if (
      !client ||
      !showEmptyState ||
      creating ||
      creatingBrowser ||
      creatingMarkdown ||
      initialEmptySessionAutoCreateRef.current === worktreeId
    ) {
      return
    }
    // Why: a sleeping/new workspace can hydrate with zero session tabs. Create
    // the first terminal once on initial load instead of leaving mobile blank.
    initialEmptySessionAutoCreateRef.current = worktreeId
    setCreateError('')
    void handleCreateTerminal()
  }, [client, creating, creatingBrowser, creatingMarkdown, showEmptyState, worktreeId])

  // Why: the reconnect loop parks at its give-up cap; without an in-session
  // affordance the only recovery is leaving the screen or restarting the
  // app (issue #5049). Surface tap-to-retry once the verdict escalates.
  const connectionVerdict = classifyConnection({
    state: connState,
    reconnectAttempts,
    lastConnectedAt
  })
  const showConnectionRetry =
    connectionVerdict.kind === 'warning' || connectionVerdict.kind === 'unreachable'

  const terminalSummary =
    connState === 'connected'
      ? showLoadingState
        ? 'Loading tabs'
        : visibleTabs.length === 1
          ? '1 tab'
          : `${visibleTabs.length} tabs`
      : showConnectionRetry
        ? `${connectionVerdict.label} — tap to retry`
        : MOBILE_SESSION_STATUS_LABELS[connState]

  // Why: keep safe-area padding in layout at all times, then visually translate
  // the controls over the terminal when the keyboard appears. iOS keyboard
  // height includes the home-indicator inset; Android IME height does not.
  const keyboardLift =
    keyboardHeight > 0
      ? Platform.OS === 'ios'
        ? Math.max(0, keyboardHeight - insets.bottom)
        : keyboardHeight
      : 0
  const activeTerminalKeyboardLift = (() => {
    if (keyboardLift <= 0 || !activeHandle) {
      return 0
    }
    const metrics = terminalKeyboardMetrics.get(activeHandle)
    if (!metrics || metrics.rows <= 0 || terminalFrameHeightRef.current <= 0) {
      return keyboardLift
    }
    if (metrics.altScreen) {
      return keyboardLift
    }
    const rowHeight = terminalFrameHeightRef.current / metrics.rows
    const cursorBottom = (metrics.cursorY + 1) * rowHeight
    const dockTop = terminalFrameHeightRef.current - keyboardLift
    const margin = rowHeight
    // Why: only move the terminal when the active cursor would sit under the
    // raised input dock. Short shell output near the top should stay put.
    return Math.min(keyboardLift, Math.max(0, cursorBottom + margin - dockTop))
  })()
  const toastAnimatedStyle = {
    opacity: toastOpacityRef.current,
    transform: [{ translateY: -keyboardLift }]
  }
  const createTabAgentActions =
    createTabAgentLoadState === 'loading'
      ? [
          {
            label: 'Detecting Agents',
            icon: Bot,
            disabled: true,
            loading: true,
            onPress: () => {}
          }
        ]
      : createTabAgentOptions.length > 0
        ? createTabAgentOptions.map((option) => ({
            label: option.label,
            renderIcon: () => <MobileAgentIcon agentId={option.agent} size={16} />,
            onPress: () => {
              setShowCreateTabDrawer(false)
              void handleCreateTerminal(option.agent)
            }
          }))
        : createTabAgentLoadState === 'loaded'
          ? [
              {
                label: 'No Enabled Agents',
                icon: Bot,
                disabled: true,
                onPress: () => {}
              }
            ]
          : createTabAgentLoadState === 'error'
            ? [
                {
                  label: 'Agent Presets Unavailable',
                  hint: 'Check the host connection',
                  icon: Bot,
                  disabled: true,
                  onPress: () => {}
                }
              ]
            : []
  const sendDiffNotesAgentActions =
    pendingDiffNotesDelivery === null
      ? []
      : createTabAgentLoadState === 'loading'
        ? [
            {
              label: 'Detecting Agents',
              icon: Bot,
              disabled: true,
              loading: true,
              onPress: () => {}
            }
          ]
        : createTabAgentOptions.length > 0
          ? createTabAgentOptions.map((option) => ({
              label: option.label,
              hint: 'New agent session',
              icon: Bot,
              onPress: () => {
                const delivery = pendingDiffNotesDelivery
                setPendingDiffNotesDelivery(null)
                if (!delivery) {
                  return
                }
                void handleCreateTerminal(option.agent, {
                  initialPrompt: delivery.prompt,
                  onPromptSent: () => void clearDeliveredDiffComments(delivery.comments)
                })
              }
            }))
          : createTabAgentLoadState === 'loaded'
            ? [
                {
                  label: 'No Enabled Agents',
                  icon: Bot,
                  disabled: true,
                  onPress: () => {}
                }
              ]
            : createTabAgentLoadState === 'error'
              ? [
                  {
                    label: 'Agent Presets Unavailable',
                    hint: 'Copy notes instead',
                    icon: Bot,
                    disabled: true,
                    onPress: () => {}
                  }
                ]
              : []

  // Routes a header panel-icon tap through the pure dock-vs-push decision (U1):
  // measured dock-capable rows toggle/swap, constrained rows push full-screen.
  const handleSessionContentRowLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width)
    setSessionContentRowWidth((prev) => (prev === width ? prev : width))
  }, [])

  const handlePanelTap = (tapped: Exclude<ActivePanel, null>) => {
    const action = resolvePanelAction({ canDock: canDockPanel, tapped, current: activePanel })
    if (action.kind === 'dock') {
      setActivePanel(action.next)
      return
    }
    router.push({
      pathname: panelRouteDescriptor(action.panel).pathname,
      params: {
        hostId,
        worktreeId,
        name: worktreeName || '',
        // Source control's post-diff-open dismissal keys off origin: 'session' (U2).
        ...(action.panel === 'sourceControl' ? { origin: 'session' } : {})
      }
    })
  }

  return (
    <View ref={setMobileSessionRootRef} style={styles.container}>
      <View style={styles.kavInner}>
        <SafeAreaView style={styles.sessionChrome} edges={['top']}>
          <View style={styles.sessionTopBar}>
            <Pressable
              style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
              onPress={requestLeaveSession}
              hitSlop={8}
              accessibilityLabel="Back to worktrees"
            >
              <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
            </Pressable>

            <View style={styles.sessionTitleBlock}>
              <Text style={styles.sessionTitle} numberOfLines={1}>
                {worktreeName || 'Terminal'}
              </Text>
              <Pressable
                style={styles.sessionMetaRow}
                disabled={!showConnectionRetry}
                onPress={() => {
                  if (hostId) {
                    void forceReconnectHost(hostId)
                  }
                }}
                accessibilityRole={showConnectionRetry ? 'button' : undefined}
                accessibilityLabel={showConnectionRetry ? 'Reconnect to desktop' : undefined}
              >
                <StatusDot state={connState} />
                <Text style={styles.sessionMetaText} numberOfLines={1}>
                  {terminalSummary}
                </Text>
              </Pressable>
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.filesButton,
                pressed && styles.filesButtonPressed,
                activePanel === 'files' && styles.filesButtonActive
              ]}
              onPress={() => handlePanelTap('files')}
              hitSlop={8}
              accessibilityLabel="Open file explorer"
            >
              <Folder size={18} color={colors.textSecondary} strokeWidth={2.1} />
            </Pressable>
            {!isFolderWorkspaceRoute && (
              <Pressable
                style={({ pressed }) => [
                  styles.filesButton,
                  pressed && styles.filesButtonPressed,
                  activePanel === 'sourceControl' && styles.filesButtonActive
                ]}
                onPress={() => handlePanelTap('sourceControl')}
                hitSlop={8}
                accessibilityLabel="Open source control"
              >
                <GitBranch size={18} color={colors.textSecondary} strokeWidth={2.1} />
              </Pressable>
            )}
            {prRepoContextLoaded && prIsGithubRepo ? (
              <Pressable
                style={({ pressed }) => [
                  styles.filesButton,
                  pressed && styles.filesButtonPressed,
                  activePanel === 'pr' && styles.filesButtonActive
                ]}
                onPress={() => handlePanelTap('pr')}
                hitSlop={8}
                accessibilityLabel="Open pull request"
              >
                <ListChecks size={18} color={colors.textSecondary} strokeWidth={2.1} />
              </Pressable>
            ) : null}
          </View>

          {visibleTabs.length > 0 && (
            <View style={styles.tabBar}>
              {/* Why: tab taps must register on the first press while the live
                  keyboard is open instead of being eaten by keyboard dismissal
                  (#5106); leaving a non-live tab still closes the keyboard
                  because the live input unmounts. */}
              <ScrollView
                ref={tabStripRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.tabScroll}
                contentContainerStyle={styles.tabContent}
                keyboardShouldPersistTaps="handled"
                scrollEventThrottle={16}
                onScroll={(e) => {
                  tabStripOffsetRef.current = e.nativeEvent.contentOffset.x
                }}
                onLayout={(e) => {
                  tabStripViewportWidthRef.current = e.nativeEvent.layout.width
                  scrollActiveTabIntoView(activeSessionTabIdRef.current, false)
                }}
                onContentSizeChange={(width) => {
                  tabStripContentWidthRef.current = width
                  scrollActiveTabIntoView(activeSessionTabIdRef.current, false)
                }}
              >
                {visibleTabs.map((t) => (
                  <Pressable
                    key={t.id}
                    style={[styles.tab, t.id === activeSessionTabId && styles.tabActive]}
                    onLayout={(e) => {
                      const { x, width } = e.nativeEvent.layout
                      tabLayoutsRef.current.set(t.id, { x, width })
                      if (t.id === activeSessionTabIdRef.current) {
                        scrollActiveTabIntoView(t.id, false)
                      }
                    }}
                    onPress={() => switchSessionTab(t)}
                    onLongPress={() => {
                      triggerMediumImpact()
                      if (t.type === 'terminal') {
                        if (typeof t.terminal !== 'string') {
                          return
                        }
                        setActionTarget({
                          handle: t.terminal,
                          title: t.title,
                          isActive: t.terminal === activeHandle
                        })
                      } else if (t.type === 'markdown') {
                        setMarkdownActionTarget(t)
                      } else if (t.type === 'file') {
                        setFileActionTarget(t)
                      } else {
                        setBrowserActionTarget(t)
                      }
                    }}
                    delayLongPress={400}
                  >
                    <View style={styles.tabLabelRow}>
                      {t.type === 'browser' && (
                        <Globe size={13} color={colors.textSecondary} strokeWidth={2.1} />
                      )}
                      {t.type === 'markdown' && (
                        <FileText size={13} color={colors.textSecondary} strokeWidth={2.1} />
                      )}
                      {t.type === 'file' && (
                        <File size={13} color={colors.textSecondary} strokeWidth={2.1} />
                      )}
                      <Text
                        style={[
                          styles.tabText,
                          t.id === activeSessionTabId && styles.tabTextActive
                        ]}
                        numberOfLines={1}
                      >
                        {getMobileSessionTabTitle(t)}
                      </Text>
                    </View>
                  </Pressable>
                ))}
                <Pressable
                  style={({ pressed }) => [
                    styles.newTerminalButton,
                    pressed && styles.newTerminalButtonPressed,
                    (creating ||
                      creatingBrowser ||
                      creatingMarkdown ||
                      connState !== 'connected') &&
                      styles.newTerminalButtonDisabled
                  ]}
                  disabled={
                    creating || creatingBrowser || creatingMarkdown || connState !== 'connected'
                  }
                  onPress={() => {
                    setCreateError('')
                    setShowCreateTabDrawer(true)
                  }}
                  accessibilityLabel="New tab"
                >
                  <Plus size={16} color={colors.textSecondary} strokeWidth={2.2} />
                </Pressable>
              </ScrollView>
            </View>
          )}
        </SafeAreaView>

        {/* Content-row host (KTD2): the header/tab chrome stays a full-width sibling
            above; on wide the post-chrome content shares this row with the docked panel.
            There is no single terminal node, so the entire conditional block is the
            flex-1 left child. On narrow the dock never renders and layout is unchanged. */}
        <View style={styles.sessionContentRow} onLayout={handleSessionContentRowLayout}>
          <View style={styles.sessionContentMain}>
            {createWarning ? (
              <View style={styles.createWarningBanner}>
                <AlertTriangle size={16} color={colors.statusAmber} strokeWidth={2.2} />
                <Text style={styles.createWarningText}>{createWarning}</Text>
                <Pressable
                  style={styles.createWarningDismiss}
                  onPress={() => setCreateWarningState(dismissMobileSessionCreateWarningState)}
                  accessibilityLabel="Dismiss workspace creation warning"
                  hitSlop={8}
                >
                  <X size={16} color={colors.textMuted} strokeWidth={2.2} />
                </Pressable>
              </View>
            ) : null}

            {showLoadingState ? (
              <View style={styles.emptyState}>
                <ActivityIndicator size="small" color={colors.textSecondary} />
              </View>
            ) : showEmptyState ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyText}>No tabs in this session</Text>
                {createError ? <Text style={styles.createError}>{createError}</Text> : null}
                <View style={styles.emptyActions}>
                  <Pressable
                    style={[
                      styles.createButton,
                      (creating ||
                        creatingBrowser ||
                        creatingMarkdown ||
                        connState !== 'connected') &&
                        styles.createButtonDisabled
                    ]}
                    disabled={
                      creating || creatingBrowser || creatingMarkdown || connState !== 'connected'
                    }
                    onPress={() => {
                      setCreateError('')
                      setShowCreateTabDrawer(true)
                    }}
                  >
                    <Text style={styles.createButtonText}>
                      {creating || creatingBrowser || creatingMarkdown
                        ? 'Creating...'
                        : 'Create Tab'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : activeMarkdownTab ? (
              <View style={styles.markdownFrame}>
                <MarkdownReader
                  documentId={activeMarkdownTab.id}
                  doc={markdownDocs.get(activeMarkdownTab.id)}
                  onRefresh={() => void readMarkdownTab(activeMarkdownTab)}
                  onChange={(content) => updateMarkdownLocalContent(activeMarkdownTab.id, content)}
                  onSave={() => void saveMarkdownTab(activeMarkdownTab)}
                  onCopy={() => void copyMarkdownLocalContent(activeMarkdownTab.id)}
                  onDiscard={() => discardMarkdownLocalContent(activeMarkdownTab)}
                  keyboardLift={keyboardLift}
                />
                {toastMessage && (
                  <Animated.View pointerEvents="none" style={[styles.toast, toastAnimatedStyle]}>
                    <Text style={styles.toastText}>{toastMessage}</Text>
                  </Animated.View>
                )}
              </View>
            ) : activeFileTab ? (
              <View style={styles.markdownFrame}>
                <FileReader
                  doc={fileDocs.get(activeFileTab.id)}
                  title={activeFileTab.title || 'File'}
                  relativePath={activeFileTab.relativePath}
                  language={activeFileTab.language}
                  diffCommentActions={
                    activeFileTab.diffSource === 'staged' || activeFileTab.diffSource === 'unstaged'
                      ? {
                          comments: diffComments,
                          busy: diffCommentBusy,
                          onAdd: addDiffCommentForFile,
                          onDelete: deleteDiffCommentForFile,
                          onCopyAll: copyDiffCommentsToClipboard,
                          onSendAll: sendDiffCommentsToAgent
                        }
                      : undefined
                  }
                />
                {toastMessage && (
                  <Animated.View pointerEvents="none" style={[styles.toast, toastAnimatedStyle]}>
                    <Text style={styles.toastText}>{toastMessage}</Text>
                  </Animated.View>
                )}
              </View>
            ) : activeBrowserTab ? (
              <View style={styles.browserFrame}>
                {/* Why: the pane owns imperative frame refs; browser tabs should
            never render a stale frame while the old stream effect cleans up. */}
                <MobileBrowserPane
                  key={activeBrowserTab.browserPageId ?? activeBrowserTab.id}
                  client={client}
                  worktreeId={worktreeId}
                  tab={activeBrowserTab}
                  screencastSupported={browserScreencastSupported}
                  keyboardLift={keyboardLift}
                  bottomInset={insets.bottom}
                  onToast={showToast}
                />
                {toastMessage && (
                  <Animated.View pointerEvents="none" style={[styles.toast, toastAnimatedStyle]}>
                    <Text style={styles.toastText}>{toastMessage}</Text>
                  </Animated.View>
                )}
              </View>
            ) : activePendingTerminalTab ? (
              <View style={styles.emptyState}>
                <ActivityIndicator size="small" color={colors.textSecondary} />
                <Text style={styles.emptyText}>
                  {activePendingTerminalTab.title || 'Loading terminal'}
                </Text>
              </View>
            ) : (
              <View
                style={styles.terminalFrame}
                onLayout={(e) => {
                  terminalFrameHeightRef.current = e.nativeEvent.layout.height
                  // Trigger a refit only when the width actually changes (sidebar
                  // resize, fold, rotation) — avoids churn on height-only changes.
                  const nextWidth = Math.round(e.nativeEvent.layout.width)
                  setTerminalFrameWidth((prev) => (prev === nextWidth ? prev : nextWidth))
                }}
              >
                {terminals.map((terminal) => (
                  <TerminalPaneView
                    key={terminal.handle}
                    handle={terminal.handle}
                    active={terminal.handle === activeHandle}
                    keyboardLift={terminal.handle === activeHandle ? activeTerminalKeyboardLift : 0}
                    terminalTheme={terminal.terminalTheme}
                    textScale={terminalTextScale}
                    onTextScaleChange={(scale) => {
                      // Why: pinch-to-zoom in the WebView reports a new preset; persist
                      // it so the size sticks across panes and app launches.
                      setTerminalTextScale(scale)
                      void saveTerminalTextScale(scale)
                    }}
                    onRef={setTerminalWebViewRef}
                    onWebReady={handleTerminalWebReady}
                    onSelectionMode={handleSelectionMode}
                    onSelectionCopy={handleSelectionCopy}
                    onSelectionEvicted={handleSelectionEvicted}
                    onModesChanged={handleModesChanged}
                    onKeyboardAvoidanceMetrics={handleKeyboardAvoidanceMetrics}
                    onHaptic={handleHaptic}
                    onTerminalInput={handleTerminalInput}
                    onTerminalTap={handleTerminalTap}
                    onFileTap={handleFileTap}
                    onOpenUrl={handleTerminalOpenUrl}
                  />
                ))}
                {toastMessage && (
                  <Animated.View pointerEvents="none" style={[styles.toast, toastAnimatedStyle]}>
                    <Text style={styles.toastText}>{toastMessage}</Text>
                  </Animated.View>
                )}
              </View>
            )}

            {/* Why: translate instead of resizing so keyboard open/close does not
            trigger a server-side PTY viewport change. */}
            {!activeMarkdownTab && !activeFileTab && !activeBrowserTab && (
              <View
                style={[
                  styles.commandDock,
                  { paddingBottom: insets.bottom, transform: [{ translateY: -keyboardLift }] }
                ]}
              >
                {/* Accessory keys */}
                <View style={styles.accessoryBar}>
                  {/* Why: with default tap handling the first tap on any accessory
                  key dismisses the open keyboard and is swallowed, so live
                  input lost its keyboard on every Esc/Tab press (#5106). */}
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.accessoryContent}
                    keyboardShouldPersistTaps="always"
                  >
                    <Pressable
                      style={({ pressed }) => [
                        styles.accessoryKey,
                        pressed && styles.accessoryKeyPressed,
                        !canSend && styles.accessoryKeyDisabled
                      ]}
                      disabled={!canSend}
                      onPress={() => {
                        if (activeHandle) {
                          void toggleDisplayMode(activeHandle)
                        }
                      }}
                      accessibilityLabel={
                        isPhoneMode(activeHandle)
                          ? 'Switch to desktop mode'
                          : 'Switch to phone mode'
                      }
                    >
                      {isPhoneMode(activeHandle) ? (
                        <Monitor
                          size={14}
                          color={canSend ? colors.textSecondary : colors.textMuted}
                        />
                      ) : (
                        <Smartphone
                          size={14}
                          color={canSend ? colors.textSecondary : colors.textMuted}
                        />
                      )}
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [
                        styles.accessoryKey,
                        liveInputEnabled && styles.accessoryKeyActive,
                        pressed && styles.accessoryKeyPressed,
                        !canSend && styles.accessoryKeyDisabled
                      ]}
                      disabled={!canSend}
                      onPress={toggleLiveInput}
                      accessibilityLabel={
                        liveInputEnabled
                          ? 'Switch to buffered command input'
                          : 'Switch to live terminal input'
                      }
                    >
                      <ChevronsRight
                        size={14}
                        color={
                          liveInputEnabled
                            ? colors.bgBase
                            : canSend
                              ? colors.textSecondary
                              : colors.textMuted
                        }
                      />
                    </Pressable>
                    {canPaste && (
                      <Pressable
                        style={({ pressed }) => [
                          styles.accessoryKey,
                          pressed && styles.accessoryKeyPressed,
                          !canSend && styles.accessoryKeyDisabled
                        ]}
                        disabled={!canSend}
                        onPress={() => void handlePaste()}
                        accessibilityLabel="Paste from clipboard"
                      >
                        <Text
                          style={[
                            styles.accessoryKeyText,
                            !canSend && styles.accessoryKeyTextDisabled
                          ]}
                        >
                          Paste
                        </Text>
                      </Pressable>
                    )}
                    {visibleBuiltInAccessoryKeys.map((key) => (
                      <Pressable
                        key={key.id}
                        style={({ pressed }) => [
                          styles.accessoryKey,
                          pressed && styles.accessoryKeyPressed,
                          !canSend && styles.accessoryKeyDisabled
                        ]}
                        disabled={!canSend}
                        onPressIn={() => {
                          if (!key.repeatable) {
                            return
                          }
                          void handleAccessoryKey(key.bytes)
                          startAccessoryRepeat(key.bytes)
                        }}
                        onPressOut={() => {
                          if (key.repeatable) {
                            stopAccessoryRepeat()
                          }
                        }}
                        onPress={() => {
                          if (key.repeatable) {
                            return
                          }
                          void handleAccessoryKey(key.bytes)
                        }}
                        accessibilityLabel={key.accessibilityLabel ?? `Send ${key.label}`}
                      >
                        <Text
                          style={[
                            styles.accessoryKeyText,
                            !canSend && styles.accessoryKeyTextDisabled
                          ]}
                        >
                          {key.label}
                        </Text>
                      </Pressable>
                    ))}
                    {customKeys.map((key) => (
                      <Pressable
                        key={key.id}
                        style={({ pressed }) => [
                          styles.accessoryKey,
                          styles.customAccessoryKey,
                          pressed && styles.accessoryKeyPressed,
                          !canSend && styles.accessoryKeyDisabled
                        ]}
                        disabled={!canSend}
                        onPress={() => void handleAccessoryKey(key.bytes)}
                        onLongPress={() => {
                          triggerMediumImpact()
                          setDeleteKeyTarget(key)
                        }}
                        delayLongPress={400}
                        accessibilityLabel={`Send ${key.label}`}
                      >
                        <Text
                          style={[
                            styles.accessoryKeyText,
                            !canSend && styles.accessoryKeyTextDisabled
                          ]}
                        >
                          {key.label}
                        </Text>
                      </Pressable>
                    ))}
                    <Pressable
                      style={({ pressed }) => [
                        styles.accessoryKey,
                        pressed && styles.accessoryKeyPressed
                      ]}
                      onPress={() => setShowCustomKeyModal(true)}
                      accessibilityLabel="Add custom shortcut"
                    >
                      <Plus size={14} color={colors.textSecondary} strokeWidth={2.2} />
                    </Pressable>
                  </ScrollView>
                </View>

                {/* Input bar */}
                {liveInputEnabled ? (
                  <Pressable
                    style={[styles.inputBar, styles.liveInputBar]}
                    disabled={!canSend}
                    onPress={focusLiveInput}
                    accessibilityLabel="Focus live terminal input"
                  >
                    <KeyboardIcon size={16} color={colors.textSecondary} strokeWidth={2} />
                    <Text style={styles.liveInputHint} numberOfLines={1}>
                      Keyboard input directly goes to terminal
                    </Text>
                    <TextInput
                      ref={liveInputRef}
                      style={styles.liveInputCapture}
                      value={liveInputCapture}
                      onChangeText={handleLiveInputChange}
                      onKeyPress={handleLiveInputKeyPress}
                      onSubmitEditing={handleLiveInputSubmit}
                      placeholder=""
                      autoCapitalize="none"
                      autoCorrect={false}
                      spellCheck={false}
                      smartInsertDelete={false}
                      keyboardType={Platform.OS === 'ios' ? 'ascii-capable' : 'visible-password'}
                      returnKeyType="default"
                      blurOnSubmit={false}
                      editable={canSend}
                      importantForAutofill="no"
                      textContentType="none"
                    />
                  </Pressable>
                ) : (
                  <View style={styles.inputBar}>
                    <TextInput
                      // Why: Android caches the IME inputType at mount, so toggling
                      // autocomplete must remount there; iOS can update without a focus-costly remount.
                      key={
                        Platform.OS === 'android'
                          ? autocompleteEnabled
                            ? 'cmd-input-ac-on'
                            : 'cmd-input-ac-off'
                          : 'cmd-input'
                      }
                      style={styles.textInput}
                      value={input}
                      onChangeText={(text) =>
                        setInput((previousText) => normalizeTerminalTextInput(text, previousText))
                      }
                      placeholder="Type a command…"
                      placeholderTextColor={colors.textMuted}
                      autoCapitalize="none"
                      autoCorrect={autocompleteEnabled}
                      spellCheck={autocompleteEnabled}
                      smartInsertDelete={false}
                      // Why: the default keyboard exposes autocomplete/autocorrect;
                      // ascii-capable (iOS) / visible-password (Android) suppress it.
                      keyboardType={
                        autocompleteEnabled
                          ? 'default'
                          : Platform.OS === 'ios'
                            ? 'ascii-capable'
                            : 'visible-password'
                      }
                      returnKeyType="send"
                      editable={canSend}
                      onSubmitEditing={() => void handleSend()}
                    />
                    <Pressable
                      style={[
                        styles.dictationButton,
                        (!canSend || isAttaching) && styles.sendButtonDisabled
                      ]}
                      disabled={!canSend || isAttaching}
                      // Tap opens the photo library straight away (one-tap, like
                      // Discord); long-press is the escape hatch for picking a file.
                      onPress={() => void attachImage('library')}
                      onLongPress={() => void attachImage('files')}
                      delayLongPress={350}
                      accessibilityLabel={isAttaching ? 'Sending image' : 'Attach a photo'}
                      accessibilityHint="Long press to attach a file instead"
                    >
                      {isAttaching ? (
                        <ActivityIndicator size="small" color={colors.textSecondary} />
                      ) : (
                        <ImagePlus size={17} color={colors.textSecondary} strokeWidth={2.4} />
                      )}
                    </Pressable>
                    <Pressable
                      style={[
                        styles.dictationButton,
                        (dictation.isStarting || dictation.isRecording) &&
                          styles.dictationButtonActive,
                        !canSend && styles.sendButtonDisabled
                      ]}
                      disabled={!canSend}
                      onPress={dictationMode === 'toggle' ? handleDictationToggle : undefined}
                      onPressIn={dictationMode === 'hold' ? handleDictationPressIn : undefined}
                      onPressOut={dictationMode === 'hold' ? handleDictationPressOut : undefined}
                      onLongPress={
                        dictationMode === 'toggle'
                          ? () => {
                              if (dictation.isRecording || dictation.isProcessing) {
                                void dictation.cancel()
                              }
                            }
                          : undefined
                      }
                      accessibilityLabel={
                        dictation.isRecording
                          ? 'Stop voice dictation'
                          : dictation.isProcessing
                            ? 'Cancel voice dictation'
                            : dictation.isStarting
                              ? 'Starting voice dictation'
                              : 'Start voice dictation'
                      }
                    >
                      {dictation.isProcessing ? (
                        <ActivityIndicator size="small" color={colors.textSecondary} />
                      ) : dictation.isStarting || dictation.isRecording ? (
                        <Mic size={17} color={colors.textPrimary} strokeWidth={2.4} />
                      ) : (
                        <Mic size={17} color={colors.textSecondary} strokeWidth={2.4} />
                      )}
                    </Pressable>
                    <Pressable
                      style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
                      disabled={!canSend}
                      onPress={() => void handleSend()}
                      accessibilityLabel="Send command"
                    >
                      <ArrowUp size={18} color={colors.textSecondary} strokeWidth={2.5} />
                    </Pressable>
                  </View>
                )}
              </View>
            )}
          </View>
          {canDockPanel && activePanel !== null && (
            <SessionDockColumn
              activePanel={activePanel}
              hostId={hostId}
              worktreeId={worktreeId}
              name={worktreeName || ''}
              client={client}
              connState={connState}
              branch={prBranch}
              headSha={prHeadSha}
              isGithubRepo={prIsGithubRepo}
              branchContextLoaded={prContextLoaded && prRepoContextLoaded}
              availableWidth={sessionContentRowWidth}
              onRequestClose={() => setActivePanel(null)}
            />
          )}
        </View>
      </View>

      <ActionSheetModal
        visible={showCreateTabDrawer}
        title="New Tab"
        actions={[
          ...createTabAgentActions,
          {
            label: 'Terminal',
            icon: SquareTerminal,
            onPress: () => {
              setShowCreateTabDrawer(false)
              void handleCreateTerminal()
            }
          },
          {
            label: 'Browser',
            icon: Globe,
            onPress: () => {
              setShowCreateTabDrawer(false)
              if (browserScreencastSupported !== true) {
                showToast('Desktop update required for mobile browser streaming', 1600)
                return
              }
              setShowCreateBrowserModal(true)
            }
          },
          {
            label: 'Markdown Note',
            icon: FileText,
            onPress: () => {
              setShowCreateTabDrawer(false)
              void handleCreateMarkdownNote()
            }
          }
        ]}
        onClose={() => setShowCreateTabDrawer(false)}
      />

      <ActionSheetModal
        visible={pendingDiffNotesDelivery !== null}
        title="Send Review Notes"
        message="Choose an agent session for the current notes."
        actions={[
          ...sendDiffNotesAgentActions,
          {
            label: 'Copy Notes',
            icon: Copy,
            onPress: () => {
              const delivery = pendingDiffNotesDelivery
              setPendingDiffNotesDelivery(null)
              if (!delivery) {
                return
              }
              void Clipboard.setStringAsync(delivery.prompt)
                .then(() => {
                  triggerSuccess()
                  showToast('Notes copied')
                })
                .catch(() => {
                  triggerError()
                  showToast("Couldn't copy notes", 1500)
                })
            }
          }
        ]}
        onClose={() => setPendingDiffNotesDelivery(null)}
      />

      <ActionSheetModal
        visible={actionTarget != null}
        title={actionTarget?.title || 'Terminal'}
        actions={[
          ...(actionTarget
            ? [
                {
                  label: isPhoneMode(actionTarget.handle) ? 'Switch to Desktop' : 'Switch to Phone',
                  icon: isPhoneMode(actionTarget.handle) ? Monitor : Smartphone,
                  onPress: () => {
                    const target = actionTarget
                    setActionTarget(null)
                    if (target) {
                      void toggleDisplayMode(target.handle)
                    }
                  }
                }
              ]
            : []),
          {
            label: 'Rename',
            onPress: () => {
              const target = actionTarget
              setActionTarget(null)
              if (target) {
                setRenameTarget(target)
              }
            }
          },
          {
            label: 'Clear Terminal',
            icon: Eraser,
            onPress: () => {
              const target = actionTarget
              setActionTarget(null)
              if (target) {
                void handleClearTerminal(target)
              }
            }
          },
          {
            label: 'Close',
            destructive: true,
            onPress: () => {
              const target = actionTarget
              setActionTarget(null)
              if (target) {
                void handleCloseTerminal(target)
              }
            }
          }
        ]}
        onClose={() => setActionTarget(null)}
      />
      <ActionSheetModal
        visible={markdownActionTarget != null}
        title={markdownActionTarget?.title || 'Markdown'}
        actions={[
          {
            label: 'Refresh',
            icon: RefreshCw,
            onPress: () => {
              const target = markdownActionTarget
              setMarkdownActionTarget(null)
              if (target) {
                discardMarkdownLocalContent(target)
              }
            }
          },
          {
            label: 'Copy Path',
            icon: FileText,
            onPress: () => {
              const target = markdownActionTarget
              setMarkdownActionTarget(null)
              if (target) {
                void Clipboard.setStringAsync(target.relativePath || target.filePath)
                showToast('Path copied')
              }
            }
          },
          {
            label: 'Close',
            destructive: true,
            onPress: () => {
              const target = markdownActionTarget
              setMarkdownActionTarget(null)
              if (target) {
                void handleCloseSessionTab(target)
              }
            }
          }
        ]}
        onClose={() => setMarkdownActionTarget(null)}
      />
      <ActionSheetModal
        visible={fileActionTarget != null}
        title={fileActionTarget?.title || 'File'}
        actions={[
          {
            label: 'Refresh',
            icon: RefreshCw,
            onPress: () => {
              const target = fileActionTarget
              setFileActionTarget(null)
              if (target) {
                void readFileTab(target)
              }
            }
          },
          {
            label: 'Close',
            destructive: true,
            onPress: () => {
              const target = fileActionTarget
              setFileActionTarget(null)
              if (target) {
                void handleCloseSessionTab(target)
              }
            }
          }
        ]}
        onClose={() => setFileActionTarget(null)}
      />
      <ActionSheetModal
        visible={browserActionTarget != null}
        title={browserActionTarget ? getMobileSessionTabTitle(browserActionTarget) : 'Browser'}
        actions={[
          ...(browserActionTarget?.canGoBack
            ? [
                {
                  label: 'Back',
                  icon: ChevronLeft,
                  onPress: () => {
                    const target = browserActionTarget
                    setBrowserActionTarget(null)
                    if (target) {
                      void handleBrowserNavigationCommand(target, 'browser.back')
                    }
                  }
                }
              ]
            : []),
          ...(browserActionTarget?.canGoForward
            ? [
                {
                  label: 'Forward',
                  icon: ChevronRight,
                  onPress: () => {
                    const target = browserActionTarget
                    setBrowserActionTarget(null)
                    if (target) {
                      void handleBrowserNavigationCommand(target, 'browser.forward')
                    }
                  }
                }
              ]
            : []),
          {
            label: 'Reload',
            icon: RefreshCw,
            onPress: () => {
              const target = browserActionTarget
              setBrowserActionTarget(null)
              if (target) {
                void handleBrowserNavigationCommand(target, 'browser.reload')
              }
            }
          },
          {
            label: 'Close',
            destructive: true,
            onPress: () => {
              const target = browserActionTarget
              setBrowserActionTarget(null)
              if (target) {
                void handleCloseSessionTab(target)
              }
            }
          }
        ]}
        onClose={() => setBrowserActionTarget(null)}
      />
      <ActionSheetModal
        visible={leaveDrafts != null}
        title="Unsaved markdown changes"
        message="Copy or discard phone drafts before leaving."
        actions={[
          {
            label: 'Copy All & Leave',
            icon: FileText,
            onPress: () => {
              const drafts = leaveDrafts ?? []
              const combined = drafts
                .map((draft) => `# ${draft.title}\n\n${draft.content}`)
                .join('\n\n---\n\n')
              void Clipboard.setStringAsync(combined)
                .then(() => {
                  setLeaveDrafts(null)
                  leaveSession()
                })
                .catch(() => {
                  triggerError()
                  showToast("Couldn't copy drafts", 1500)
                })
            }
          },
          {
            label: 'Discard & Leave',
            destructive: true,
            onPress: () => {
              setLeaveDrafts(null)
              leaveSession()
            }
          }
        ]}
        onClose={() => setLeaveDrafts(null)}
      />
      <ConfirmModal
        visible={discardMarkdownTarget != null}
        title="Discard Changes"
        message="Replace the phone draft with the latest desktop file?"
        confirmLabel="Discard"
        destructive
        onConfirm={confirmDiscardMarkdown}
        onCancel={() => setDiscardMarkdownTarget(null)}
      />
      <TextInputModal
        visible={renameTarget != null}
        title="Rename Terminal"
        defaultValue={renameTarget?.title || 'Terminal'}
        placeholder="Terminal name"
        onSubmit={(value) => void handleRenameTerminal(value)}
        onCancel={() => setRenameTarget(null)}
      />
      <TextInputModal
        visible={showCreateBrowserModal}
        title="New Browser"
        message="Enter a URL, or leave blank for a new tab."
        defaultValue=""
        placeholder="https://example.com"
        submitLabel="Open"
        allowEmpty
        selectTextOnFocus
        keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
        onSubmit={(value) => {
          void handleCreateBrowser(value).then((created) => {
            if (created) {
              setShowCreateBrowserModal(false)
            }
          })
        }}
        onCancel={() => setShowCreateBrowserModal(false)}
      />
      <CustomKeyModal
        visible={showCustomKeyModal}
        onClose={() => setShowCustomKeyModal(false)}
        onKeysChanged={setCustomKeys}
        onManageShortcuts={handleManageShortcuts}
      />
      <MobileDictationSetupSheet
        visible={showDictationSetup}
        client={client}
        onClose={() => setShowDictationSetup(false)}
        onReady={() => setShowDictationSetup(false)}
      />
      <ActionSheetModal
        visible={deleteKeyTarget != null}
        title={deleteKeyTarget?.label ?? 'Shortcut'}
        message="Remove this custom shortcut?"
        actions={[
          {
            label: 'Remove',
            destructive: true,
            onPress: () => {
              if (deleteKeyTarget) {
                void handleDeleteCustomKey(deleteKeyTarget)
              }
              setDeleteKeyTarget(null)
            }
          }
        ]}
        onClose={() => setDeleteKeyTarget(null)}
      />
    </View>
  )
}
