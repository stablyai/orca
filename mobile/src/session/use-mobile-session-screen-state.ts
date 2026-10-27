import { useState, useRef, useMemo } from 'react'
import { Animated, type ScrollView } from 'react-native'
import type { MobileTerminalLinkOpenMode } from '../storage/preferences'
import type { TerminalKeyboardAvoidanceMetrics } from '../terminal/terminal-webview-contract'
import {
  getDefaultTerminalAccessoryBuiltInIds,
  getVisibleTerminalAccessoryKeys
} from '../terminal/terminal-accessory-layout'
import type { CustomKey } from '../terminal/terminal-custom-keys'
import type { MobileNewTabAgentOption } from './mobile-new-tab-agent-options'
import { useTerminalLiveInputModePreference } from './use-terminal-live-input-mode-preference'
import type { AppliedSnapshotMarker } from './session-tab-snapshot-gate'
import { useWorktreeSessionTabsLoaded } from './use-initial-session-terminal-autocreate'
import { createMobileSessionCreateWarningState } from './mobile-session-create-warning-state'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type {
  DiffNotesDelivery,
  DirtyMarkdownDraft,
  FileDocState,
  MarkdownDocState,
  MobileDisplayMode,
  MobileNewTabAgentLoadState,
  MobileSessionTab,
  Terminal
} from './mobile-session-route-types'
import { useMobileSessionTabActionTargets } from './use-mobile-session-tab-action-targets'
import type { MobileSessionFoundationModel } from './use-mobile-session-foundation'

export function useMobileSessionScreenState(scope: MobileSessionFoundationModel) {
  const { worktreeId, hostId, initialCreateWarning } = scope
  const [terminals, setTerminals] = useState<Terminal[]>([])
  const terminalsRef = useRef<Terminal[]>([])
  const [sessionTabs, setSessionTabs] = useState<MobileSessionTab[]>([])
  const sessionTabsRef = useRef<MobileSessionTab[]>([])
  const appliedSnapshotMarkerRef = useRef<AppliedSnapshotMarker>({ epoch: null, version: -1 })
  const appliedSessionTabsRevisionRef = useRef(0)
  const closedTabTombstonesRef = useRef<Map<string, number>>(new Map())
  const [terminalsLoaded, setTerminalsLoaded] = useWorktreeSessionTabsLoaded(worktreeId)
  const [input, setInput] = useState('')
  const [terminalTextScale, setTerminalTextScale] = useState(1)
  const terminalTextScaleRevisionRef = useRef(0)
  const [autocompleteEnabled, setAutocompleteEnabled] = useState(false)
  const [terminalLinkOpenMode, setTerminalLinkOpenMode] =
    useState<MobileTerminalLinkOpenMode>('orca-browser')
  const [liveInputCapture, setLiveInputCapture] = useState('')
  const {
    clearTerminalLiveInputDefault,
    defaultTerminalHandlesToLiveInput,
    liveInputTerminalHandles,
    liveInputTerminalHandlesRef,
    pruneTerminalHandlesFromLiveInput,
    toggleTerminalLiveInput
  } = useTerminalLiveInputModePreference({ hostId, worktreeId })
  const [activeHandle, setActiveHandle] = useState<string | null>(null)
  const [coveredStreamRevision, setCoveredStreamRevision] = useState(0)
  const [activeSessionTabId, setActiveSessionTabId] = useState<string | null>(null)
  const activeSessionTabIdRef = useRef<string | null>(null)
  // Preserve an explicit phone tab pick while a host snapshot is transiently incomplete.
  const selectedSessionTabIdRef = useRef<string | null>(null)
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
  const [createTabAgentLoadState, setCreateTabAgentLoadState] =
    useState<MobileNewTabAgentLoadState>('idle')
  const [createTabAgentOptions, setCreateTabAgentOptions] = useState<MobileNewTabAgentOption[]>([])
  const [showCreateBrowserModal, setShowCreateBrowserModal] = useState(false)
  const [showHeaderMoreActions, setShowHeaderMoreActions] = useState(false)
  const sessionTabActionTargets = useMobileSessionTabActionTargets()
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
  // Expo edge-to-edge keeps window size on IME open; lift input from keyboard height without resizing the desktop PTY.
  const [keyboardHeight, setKeyboardHeight] = useState(0)
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
  const toastOpacityRef = useRef(new Animated.Value(0))
  const toastHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastSeqRef = useRef(0)
  return {
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
    input,
    setInput,
    terminalTextScale,
    setTerminalTextScale,
    terminalTextScaleRevisionRef,
    autocompleteEnabled,
    setAutocompleteEnabled,
    terminalLinkOpenMode,
    setTerminalLinkOpenMode,
    liveInputCapture,
    setLiveInputCapture,
    clearTerminalLiveInputDefault,
    defaultTerminalHandlesToLiveInput,
    liveInputTerminalHandles,
    liveInputTerminalHandlesRef,
    pruneTerminalHandlesFromLiveInput,
    toggleTerminalLiveInput,
    activeHandle,
    setActiveHandle,
    coveredStreamRevision,
    setCoveredStreamRevision,
    activeSessionTabId,
    setActiveSessionTabId,
    activeSessionTabIdRef,
    selectedSessionTabIdRef,
    tabStripRef,
    tabStripOffsetRef,
    tabStripViewportWidthRef,
    tabStripContentWidthRef,
    tabLayoutsRef,
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
    createTabAgentLoadState,
    setCreateTabAgentLoadState,
    createTabAgentOptions,
    setCreateTabAgentOptions,
    showCreateBrowserModal,
    setShowCreateBrowserModal,
    showHeaderMoreActions,
    setShowHeaderMoreActions,
    ...sessionTabActionTargets,
    discardMarkdownTarget,
    setDiscardMarkdownTarget,
    leaveDrafts,
    setLeaveDrafts,
    renameTarget,
    setRenameTarget,
    customKeys,
    setCustomKeys,
    visibleBuiltInIds,
    setVisibleBuiltInIds,
    showCustomKeyModal,
    setShowCustomKeyModal,
    deleteKeyTarget,
    setDeleteKeyTarget,
    visibleBuiltInAccessoryKeys,
    keyboardHeight,
    setKeyboardHeight,
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
