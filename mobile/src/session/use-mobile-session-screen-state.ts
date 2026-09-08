import { useState, useRef, useMemo } from 'react'
import { Animated, type ScrollView } from 'react-native'
import type { MobileTerminalLinkOpenMode } from '../storage/preferences'
import type { TerminalKeyboardAvoidanceMetrics } from '../terminal/terminal-webview-contract'
import {
  getDefaultTerminalAccessoryBuiltInIds,
  getVisibleTerminalAccessoryKeys
} from '../terminal/terminal-accessory-layout'
import type { CustomKey } from '../components/CustomKeyModal'
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
import { useMobileKeyboardInset } from '../hooks/use-mobile-keyboard-inset'
import type { HostSessionTabOperations } from './host-session-tab-operations'
import { MobileSessionFileDocLifecycle } from './mobile-session-file-doc-lifecycle'
import { MobileSessionMarkdownDocLifecycle } from './mobile-session-markdown-doc-lifecycle'
import { TerminalSettingsModalHandoff } from './terminal-settings-modal-handoff'
import { useMobileSessionMarkdownDrafts } from './use-mobile-session-markdown-drafts'

export function useMobileSessionScreenState(scope: MobileSessionFoundationModel) {
  const { worktreeId, hostId, initialCreateWarning, sessionMarkdownOperations } = scope
  const [terminals, setTerminals] = useState<Terminal[]>([])
  const terminalsRef = useRef<Terminal[]>([])
  const [sessionTabs, setSessionTabs] = useState<MobileSessionTab[]>([])
  const sessionTabsRef = useRef<MobileSessionTab[]>([])
  const [workspaceTransportState, setWorkspaceTransportState] = useState<
    'available' | 'unavailable'
  >('available')
  // Why: track the last applied (epoch, version) so a late older snapshot can't overwrite a newer one and resurrect closed tabs (session-tab-snapshot-gate).
  const appliedSnapshotMarkerRef = useRef<AppliedSnapshotMarker>({ epoch: null, version: -1 })
  const appliedSessionTabsRevisionRef = useRef(0)
  // Why: after an optimistic close, suppress the tab (with expiry) until the publisher confirms, so an in-flight snapshot can't flash it back.
  const closedTabTombstonesRef = useRef<Map<string, number>>(new Map())
  const [terminalsLoaded, setTerminalsLoaded] = useWorktreeSessionTabsLoaded(worktreeId)
  const [input, setInput] = useState('')
  // Why: baseline terminal zoom reloaded on focus so a Settings → Terminal change applies in place (panes stay mounted).
  const [terminalTextScale, setTerminalTextScale] = useState(1)
  // Why: terminal command-bar autocomplete opt-in, reloaded on focus so a Settings → Terminal toggle takes effect on return.
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
  // Reactive teardown signal for the native-chat covered stream; see unsubscribeTerminal.
  const [coveredStreamRevision, setCoveredStreamRevision] = useState(0)
  const [activeSessionTabId, setActiveSessionTabId] = useState<string | null>(null)
  const activeSessionTabIdRef = useRef<string | null>(null)
  // Preserve an explicit phone tab pick while a host snapshot is transiently incomplete.
  const selectedSessionTabIdRef = useRef<string | null>(null)
  // Auto-scroll the tab strip so the desktop-synced active tab is revealed without a manual scroll.
  const tabStripRef = useRef<ScrollView>(null)
  const tabStripOffsetRef = useRef(0)
  const tabStripViewportWidthRef = useRef(0)
  const tabStripContentWidthRef = useRef(0)
  const tabLayoutsRef = useRef<Map<string, { x: number; width: number }>>(new Map())
  const [markdownDocs, setMarkdownDocs] = useState<Map<string, MarkdownDocState>>(new Map())
  const markdownDocsRef = useRef<Map<string, MarkdownDocState>>(new Map())
  const markdownDocLifecycleRef = useRef(new MobileSessionMarkdownDocLifecycle())
  const [fileDocs, setFileDocs] = useState<Map<string, FileDocState>>(new Map())
  const fileDocLifecycleRef = useRef(new MobileSessionFileDocLifecycle())
  const [diffComments, setDiffComments] = useState<DiffComment[]>([])
  const diffCommentsRef = useRef<DiffComment[]>([])
  const [diffCommentBusy, setDiffCommentBusy] = useState(false)
  const [pendingDiffNotesDelivery, setPendingDiffNotesDelivery] =
    useState<DiffNotesDelivery | null>(null)
  const [creating, setCreating] = useState(false)
  // Why: React state isn't a synchronous lock; this ref blocks a double-tap's second create in the same tick before `creating` re-renders.
  const creatingTerminalRef = useRef(false)
  const pendingQuickCommandInputRef = useRef<
    Map<string, { text: string; enter: false; successToast: string }>
  >(new Map())
  const [creatingBrowser, setCreatingBrowser] = useState(false)
  const [creatingMarkdown, setCreatingMarkdown] = useState(false)
  const [createError, setCreateError] = useState('')
  const [createWarningState, setCreateWarningState] = useState(() =>
    createMobileSessionCreateWarningState(initialCreateWarning)
  )
  const [showCreateTabDrawer, setShowCreateTabDrawer] = useState(false)
  const [quickCommandsOpenFor, setQuickCommandsOpenFor] = useState<HostSessionTabOperations | null>(
    null
  )
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
  const {
    markEdited: markMarkdownDraftEdited,
    clearDraft: clearMarkdownDraft,
    clearDrafts: clearMarkdownDrafts
  } = useMobileSessionMarkdownDrafts({
    workspaceId: worktreeId,
    tabs: sessionTabs,
    docs: markdownDocs,
    setDocs: setMarkdownDocs,
    operations: sessionMarkdownOperations
  })
  const [renameTarget, setRenameTarget] = useState<Terminal | null>(null)
  const [customKeys, setCustomKeys] = useState<CustomKey[]>([])
  const [visibleBuiltInIds, setVisibleBuiltInIds] = useState<string[]>(
    getDefaultTerminalAccessoryBuiltInIds
  )
  const [showCustomKeyModal, setShowCustomKeyModal] = useState(false)
  const terminalSettingsModalHandoffRef = useRef(new TerminalSettingsModalHandoff())
  const [deleteKeyTarget, setDeleteKeyTarget] = useState<CustomKey | null>(null)
  const visibleBuiltInAccessoryKeys = useMemo(
    () => getVisibleTerminalAccessoryKeys(visibleBuiltInIds),
    [visibleBuiltInIds]
  )
  // Why: Expo SDK 55 edge-to-edge doesn't resize the window on IME open, so track keyboard height ourselves and lift the input without resizing the desktop PTY.
  const keyboardHeight = useMobileKeyboardInset().height
  // Why: server-authoritative display mode per terminal, populated from subscribe responses.
  const [terminalModes, setTerminalModes] = useState<Map<string, MobileDisplayMode>>(new Map())
  const [terminalKeyboardMetrics, setTerminalKeyboardMetrics] = useState<
    Map<string, TerminalKeyboardAvoidanceMetrics>
  >(new Map())
  const [selectModeActive, setSelectModeActive] = useState(false)
  const [canPaste, setCanPaste] = useState(false)
  const [showDictationSetup, setShowDictationSetup] = useState(false)
  // 'hold' = press-and-hold mic, 'toggle' = tap-to-start/stop; mirrors Settings ▸ Voice ▸ Dictation Mode.
  const [dictationMode, setDictationMode] = useState<'toggle' | 'hold'>('toggle')
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
    quickCommandsOpenFor,
    setQuickCommandsOpenFor,
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
    toastMessage,
    setToastMessage,
    toastOpacityRef,
    toastHideTimerRef,
    toastSeqRef,
    workspaceTransportState,
    setWorkspaceTransportState,
    markdownDocLifecycleRef,
    fileDocLifecycleRef,
    pendingQuickCommandInputRef,
    terminalSettingsModalHandoffRef,
    markMarkdownDraftEdited,
    clearMarkdownDraft,
    clearMarkdownDrafts
  }
}

export type MobileSessionScreenStateModel = MobileSessionFoundationModel &
  ReturnType<typeof useMobileSessionScreenState>
