import { useState, useRef, useMemo } from 'react'
import { useTerminalSplitLayout } from '../terminal/session/use-terminal-split-layout'
import { createLiveInputCapture } from '../terminal/session/live-input-capture'
import { Animated } from 'react-native'
import type { MobileAnimatedValue } from '../platform/animated-handles'
import type { MobileTerminalLinkOpenMode } from '../storage/preferences'
import type { TerminalKeyboardAvoidanceMetrics } from '../terminal/terminal-webview-contract'
import {
  getDefaultTerminalAccessoryBuiltInIds,
  getVisibleTerminalAccessoryKeys
} from '../terminal/terminal-accessory-layout'
import type { CustomKey } from '../terminal/terminal-custom-keys'
import type { AppliedSnapshotMarker } from './tabs/session-tab-snapshot-gate'
import { useWorktreeSessionTabsLoaded } from '../terminal/session/use-initial-session-terminal-autocreate'
import { createMobileSessionCreateWarningState } from './tabs/mobile-session-create-warning-state'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { DiffNotesDelivery } from '../source-control/review/mobile-review-comment-state'
import type {
  DirtyMarkdownDraft,
  FileDocState,
  MarkdownDocState
} from '../files/session-documents/session-document-state'
import type { MobileDisplayMode, Terminal } from '../terminal/session/mobile-terminal-model'
import type { MobileSessionTab } from './tabs/mobile-session-tabs'
import { useMobileSessionTabActionTargets } from './tabs/use-mobile-session-tab-action-targets'
import type { MobileSessionFoundationModel } from './use-mobile-session-foundation'

export function useMobileSessionScreenState(scope: MobileSessionFoundationModel) {
  const { worktreeId, initialCreateWarning } = scope
  const terminalSplitLayout = useTerminalSplitLayout()
  const [terminals, setTerminals] = useState<Terminal[]>([])
  const terminalsRef = useRef<Terminal[]>([])
  const [sessionTabs, setSessionTabs] = useState<MobileSessionTab[]>([])
  const sessionTabsRef = useRef<MobileSessionTab[]>([])
  const appliedSnapshotMarkerRef = useRef<AppliedSnapshotMarker>({ epoch: null, version: -1 })
  const appliedSessionTabsRevisionRef = useRef(0)
  const closedTabTombstonesRef = useRef<Map<string, number>>(new Map())
  const [terminalsLoaded, setTerminalsLoaded] = useWorktreeSessionTabsLoaded(worktreeId)
  const [terminalTextScale, setTerminalTextScale] = useState(1)
  const terminalTextScaleRevisionRef = useRef(0)
  const [terminalLinkOpenMode, setTerminalLinkOpenMode] =
    useState<MobileTerminalLinkOpenMode>('orca-browser')
  const [liveInputCapture] = useState(createLiveInputCapture)
  const [activeHandle, setActiveHandle] = useState<string | null>(null)
  const [coveredStreamRevision, setCoveredStreamRevision] = useState(0)
  const [activeSessionTabId, setActiveSessionTabId] = useState<string | null>(null)
  const activeSessionTabIdRef = useRef<string | null>(null)
  // Preserve an explicit phone tab pick while a host snapshot is transiently incomplete.
  const selectedSessionTabIdRef = useRef<string | null>(null)
  const [markdownDocs, setMarkdownDocs] = useState<Map<string, MarkdownDocState>>(new Map())
  const markdownDocsRef = useRef<Map<string, MarkdownDocState>>(new Map())
  const [fileDocs, setFileDocs] = useState<Map<string, FileDocState>>(new Map())
  const [diffComments, setDiffComments] = useState<DiffComment[]>([])
  const diffCommentsRef = useRef<DiffComment[]>([])
  const [diffCommentBusy, setDiffCommentBusy] = useState(false)
  const [pendingDiffNotesDelivery, setPendingDiffNotesDelivery] =
    useState<DiffNotesDelivery | null>(null)
  const [creating, setCreating] = useState(false)
  // Use a synchronous create id lock to block same-tick double taps and prevent old launches from releasing newer locks.
  const creatingTerminalRef = useRef<string | null>(null)
  const [creatingBrowser, setCreatingBrowser] = useState(false)
  const [creatingMarkdown, setCreatingMarkdown] = useState(false)
  const [createError, setCreateError] = useState('')
  const [createWarningState, setCreateWarningState] = useState(() =>
    createMobileSessionCreateWarningState(initialCreateWarning)
  )
  const [showCreateTabDrawer, setShowCreateTabDrawer] = useState(false)
  const [showQuickCommands, setShowQuickCommands] = useState(false)
  const [showCreateBrowserModal, setShowCreateBrowserModal] = useState(false)
  const [showHeaderMoreActions, setShowHeaderMoreActions] = useState(false)
  const [showTerminalLayout, setShowTerminalLayout] = useState(false)
  const sessionTabActionTargets = useMobileSessionTabActionTargets()
  const [discardMarkdownTarget, setDiscardMarkdownTarget] = useState<Extract<
    MobileSessionTab,
    { type: 'markdown' }
  > | null>(null)
  const [leaveDrafts, setLeaveDrafts] = useState<DirtyMarkdownDraft[] | null>(null)
  const [renameTarget, setRenameTarget] = useState<Terminal | null>(null)
  const [customKeys, setCustomKeys] = useState<CustomKey[]>([])
  const [directionPadEnabled, setDirectionPadEnabled] = useState(true)
  const [smartRailEnabled, setSmartRailEnabled] = useState(false)
  const [visibleBuiltInIds, setVisibleBuiltInIds] = useState<string[]>(
    getDefaultTerminalAccessoryBuiltInIds
  )
  const [showCustomKeyModal, setShowCustomKeyModal] = useState(false)
  const [deleteKeyTarget, setDeleteKeyTarget] = useState<CustomKey | null>(null)
  const visibleBuiltInAccessoryKeys = useMemo(
    () => getVisibleTerminalAccessoryKeys(visibleBuiltInIds),
    [visibleBuiltInIds]
  )
  const [terminalModes, setTerminalModes] = useState<Map<string, MobileDisplayMode>>(new Map())
  const [terminalKeyboardMetrics, setTerminalKeyboardMetrics] = useState<
    Map<string, TerminalKeyboardAvoidanceMetrics>
  >(new Map())
  const [selectModeActive, setSelectModeActive] = useState(false)
  const [canPaste, setCanPaste] = useState(false)
  const [showDictationSetup, setShowDictationSetup] = useState(false)
  // Only known hold/toggle modes bind mic handlers; preserve unknown/absent host values as inert until setup resolves.
  const [dictationMode, setDictationMode] = useState<string | undefined>('toggle')
  const [dictationEnabled, setDictationEnabled] = useState(true)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const toastOpacityRef = useRef<MobileAnimatedValue>(new Animated.Value(0))
  const toastHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastSeqRef = useRef(0)
  return {
    ...terminalSplitLayout,
    terminals,
    setTerminals,
    terminalsRef,
    sessionTabs,
    setSessionTabs,
    sessionTabsRef,
    appliedSnapshotMarkerRef,
    appliedSessionTabsRevisionRef,
    closedTabTombstonesRef,
    terminalsLoaded,
    setTerminalsLoaded,
    terminalTextScale,
    setTerminalTextScale,
    terminalTextScaleRevisionRef,
    terminalLinkOpenMode,
    setTerminalLinkOpenMode,
    liveInputCapture,
    setLiveInputCapture: liveInputCapture.set,
    activeHandle,
    setActiveHandle,
    coveredStreamRevision,
    setCoveredStreamRevision,
    activeSessionTabId,
    setActiveSessionTabId,
    activeSessionTabIdRef,
    selectedSessionTabIdRef,
    markdownDocs,
    setMarkdownDocs,
    markdownDocsRef,
    fileDocs,
    setFileDocs,
    diffComments,
    setDiffComments,
    diffCommentsRef,
    diffCommentBusy,
    setDiffCommentBusy,
    pendingDiffNotesDelivery,
    setPendingDiffNotesDelivery,
    creating,
    setCreating,
    creatingTerminalRef,
    creatingBrowser,
    setCreatingBrowser,
    creatingMarkdown,
    setCreatingMarkdown,
    createError,
    setCreateError,
    createWarningState,
    setCreateWarningState,
    showCreateTabDrawer,
    setShowCreateTabDrawer,
    showQuickCommands,
    setShowQuickCommands,
    showCreateBrowserModal,
    setShowCreateBrowserModal,
    showHeaderMoreActions,
    setShowHeaderMoreActions,
    showTerminalLayout,
    setShowTerminalLayout,
    ...sessionTabActionTargets,
    discardMarkdownTarget,
    setDiscardMarkdownTarget,
    leaveDrafts,
    setLeaveDrafts,
    renameTarget,
    setRenameTarget,
    customKeys,
    setCustomKeys,
    directionPadEnabled,
    setDirectionPadEnabled,
    smartRailEnabled,
    setSmartRailEnabled,
    visibleBuiltInIds,
    setVisibleBuiltInIds,
    showCustomKeyModal,
    setShowCustomKeyModal,
    deleteKeyTarget,
    setDeleteKeyTarget,
    visibleBuiltInAccessoryKeys,
    terminalModes,
    setTerminalModes,
    terminalKeyboardMetrics,
    setTerminalKeyboardMetrics,
    selectModeActive,
    setSelectModeActive,
    canPaste,
    setCanPaste,
    showDictationSetup,
    setShowDictationSetup,
    dictationMode,
    setDictationMode,
    dictationEnabled,
    setDictationEnabled,
    toastMessage,
    setToastMessage,
    toastOpacityRef,
    toastHideTimerRef,
    toastSeqRef
  }
}

export type MobileSessionScreenStateModel = MobileSessionFoundationModel &
  ReturnType<typeof useMobileSessionScreenState>
