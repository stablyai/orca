import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useSyncExternalStore,
  type MutableRefObject
} from 'react'
import { useFocusEffect } from 'expo-router'
import type {
  TerminalChatPair,
  TerminalTabViewMode
} from '../../../src/shared/terminal-tab-view-mode'
import {
  refreshDefaultSessionView,
  useDefaultSessionView
} from '../storage/default-session-view-store'
import type { RpcClient } from '../transport/rpc-client'
import {
  bindMobileChatPairRoute,
  getMobileChatPairWrites,
  mobileChatPairKeyId,
  mobileChatPairKeysInScope,
  readMobileChatPairOverlay,
  subscribeMobileChatPairOverlay,
  type MobileChatPairRouteBinding
} from './mobile-session-chat-pair-writes'
import { sendMobileChatPairWrite } from './mobile-session-chat-pair-send'
import {
  chatPairTargetForView,
  chatViewLeafId,
  chatViewLeafIds,
  chatViewParentTabId,
  hostChatPairForRow,
  resolveMobileLeafView,
  type MobileChatViewRow,
  type MobileLeafView,
  type MobileNativeChatReadability
} from './mobile-session-chat-view'
import {
  advanceChatViewRetention,
  EMPTY_CHAT_VIEW_RETENTION,
  type ChatViewRetention
} from './mobile-session-chat-view-retention'
import type { MobileSessionTab } from './mobile-session-route-types'
import {
  resolveMobileNativeChat,
  type MobileNativeChatResolution
} from './mobile-native-chat-eligibility'
import { useMobileSessionViewMode } from './use-mobile-session-view-mode'

export const CHAT_VIEW_SWITCH_UNCONFIRMED_MESSAGE = "Couldn't confirm the view switch"

type TerminalRow = Extract<MobileSessionTab, { type: 'terminal' }>

export type MobileSessionChatView = {
  /** Whether the latest accepted snapshot came from a host that owns the chat pair. */
  markerSession: boolean
  tabLeafView: (tab: MobileSessionTab | null) => MobileLeafView
  isTabChatView: (tabId: string) => boolean
  /** Switches a tab to the named view; a user action, never a computed toggle. */
  setTabChatView: (tabId: string, view: TerminalTabViewMode) => void
  /** The last transcript identity seen behind the row's current terminal process. */
  retainedIdentity: (tabId: string | null) => MobileNativeChatResolution | null
}

function terminalRows(tabs: readonly MobileSessionTab[]): TerminalRow[] {
  return tabs.filter((tab): tab is TerminalRow => tab.type === 'terminal')
}

/**
 * Which view each terminal leaf shows. On a host that owns the chat pair the phone renders that
 * pair (with its own pending click on top) and sends fenced writes; otherwise the device-local
 * legacy overrides still decide.
 */
export function useMobileSessionChatView(args: {
  hostId: string
  worktreeId: string
  client: RpcClient | null
  sessionTabs: readonly MobileSessionTab[]
  sessionTabsRef: MutableRefObject<MobileSessionTab[]>
  markerSession: boolean
  /** Whether this screen has accepted a snapshot for its scope; until then its rows are empty. */
  snapshotAccepted: boolean
  readability: MobileNativeChatReadability
  onSwitchUnconfirmed: (message: string) => void
}): MobileSessionChatView {
  const {
    hostId,
    worktreeId,
    client,
    sessionTabs,
    sessionTabsRef,
    markerSession,
    snapshotAccepted,
    readability
  } = args
  // Why always mounted: hooks cannot be conditional; on marker sessions its overrides are never consulted or written.
  const { isTabChatView: legacyIsTabChatView, toggleTabChatView: legacyToggleTabChatView } =
    useMobileSessionViewMode({ hostId, worktreeId })
  const defaultView = useDefaultSessionView()
  // Why: the route binding outlives renders; these read the latest client and callback without re-binding.
  const sendWrite = useEffectEvent(
    (write: Omit<Parameters<typeof sendMobileChatPairWrite>[0], 'client'>) =>
      sendMobileChatPairWrite({ ...write, client })
  )
  const reportSwitchUnconfirmed = useEffectEvent(() =>
    args.onSwitchUnconfirmed(CHAT_VIEW_SWITCH_UNCONFIRMED_MESSAGE)
  )
  const overlay = useSyncExternalStore(subscribeMobileChatPairOverlay, readMobileChatPairOverlay)
  const scope = `${hostId}\0${worktreeId}`
  const snapshotAcceptedRef = useRef(snapshotAccepted)
  useEffect(() => {
    snapshotAcceptedRef.current = snapshotAccepted
  }, [snapshotAccepted])

  useFocusEffect(
    useCallback(() => {
      void refreshDefaultSessionView()
    }, [])
  )

  useEffect(() => {
    const readHostPair = (parentTabId: string): TerminalChatPair | null => {
      const row = terminalRows(sessionTabsRef.current).find(
        (candidate) => chatViewParentTabId(candidate) === parentTabId
      )
      return row ? hostChatPairForRow(row) : null
    }
    const binding: MobileChatPairRouteBinding = {
      ready: () => snapshotAcceptedRef.current,
      readHostPair,
      send: (parentTabId, request, write) =>
        sendWrite({
          worktreeId,
          parentTabId,
          request,
          write,
          hostPair: () => readHostPair(parentTabId)
        }),
      reportFailure: () => reportSwitchUnconfirmed()
    }
    return bindMobileChatPairRoute(hostId, worktreeId, binding)
  }, [hostId, scope, sessionTabsRef, worktreeId])

  const pendingPairFor = useCallback(
    (row: MobileChatViewRow): TerminalChatPair | null =>
      overlay.get(
        mobileChatPairKeyId({ hostId, worktreeId, parentTabId: chatViewParentTabId(row) })
      ) ?? null,
    [hostId, overlay, worktreeId]
  )
  // Why committed in an effect: a render React discards must not rewrite what the route remembers.
  const retentionRef = useRef<{ scope: string; retention: ChatViewRetention }>({
    scope: '',
    retention: EMPTY_CHAT_VIEW_RETENTION
  })
  const retention = useMemo(
    () =>
      advanceChatViewRetention(
        retentionRef.current.scope === scope
          ? retentionRef.current.retention
          : EMPTY_CHAT_VIEW_RETENTION,
        {
          rows: terminalRows(sessionTabs),
          readability,
          hostPairFor: hostChatPairForRow,
          pendingPairFor
        }
      ),
    [pendingPairFor, readability, scope, sessionTabs]
  )
  useEffect(() => {
    retentionRef.current = { scope, retention }
  }, [retention, scope])

  // Why not reactive: retention changes with the overlay too, and only a new snapshot settles writes.
  const processChangedRows = useEffectEvent(() => retention.processChanged)
  const appliedRef = useRef<{ scope: string; marker: boolean | null }>({ scope: '', marker: null })
  useEffect(() => {
    // Why: switches are shared by every screen for the worktree; one with no snapshot yet knows nothing.
    if (!snapshotAccepted) {
      return
    }
    const writes = getMobileChatPairWrites()
    const rows = terminalRows(sessionTabs)
    const processChanged = processChangedRows()
    const previous = appliedRef.current
    appliedRef.current = { scope, marker: markerSession }
    const markerFlipped =
      previous.scope === scope && previous.marker !== null && previous.marker !== markerSession
    for (const key of mobileChatPairKeysInScope(hostId, worktreeId)) {
      const parentRows = rows.filter((row) => chatViewParentTabId(row) === key.parentTabId)
      // Why: a marker flip changes which logic decides, and a new PTY is a different session.
      if (
        markerFlipped ||
        parentRows.length === 0 ||
        parentRows.some((row) => processChanged.has(row.id))
      ) {
        writes.drop(key)
        continue
      }
      writes.hostPairChanged(key)
    }
  }, [hostId, markerSession, scope, sessionTabs, snapshotAccepted, worktreeId])

  /** The pair this device shows: its pending click, else the host's, with an ownerless chat placed. */
  const displayPair = useCallback(
    (row: TerminalRow): TerminalChatPair | 'undecided' => {
      const pair = pendingPairFor(row) ?? hostChatPairForRow(row)
      if (pair.viewMode !== 'chat' || pair.chatLeafId) {
        return pair
      }
      const placed = retention.ownerlessChatLeaves.get(chatViewParentTabId(row))
      if (!placed) {
        return { viewMode: 'terminal' }
      }
      if (!placed.settled) {
        // Why: the same wait as an unswitched tab, so a gated agent does not flash terminal first.
        return placed.leafId === chatViewLeafId(row) ? 'undecided' : { viewMode: 'terminal' }
      }
      return { viewMode: 'chat', chatLeafId: placed.leafId }
    },
    [pendingPairFor, retention]
  )

  const tabLeafView = useCallback(
    (tab: MobileSessionTab | null): MobileLeafView => {
      if (tab?.type === 'agent-session') {
        return 'chat'
      }
      if (tab?.type !== 'terminal') {
        return 'terminal'
      }
      if (!markerSession) {
        return legacyIsTabChatView(tab.id) &&
          resolveMobileNativeChat(tab, readability === 'readable')
          ? 'chat'
          : 'terminal'
      }
      const pair = displayPair(tab)
      return pair === 'undecided'
        ? 'undecided'
        : resolveMobileLeafView(tab, pair, chatViewLeafIds(tab, terminalRows(sessionTabs)), {
            defaultView,
            readability
          })
    },
    [defaultView, displayPair, legacyIsTabChatView, markerSession, readability, sessionTabs]
  )

  const isTabChatView = useCallback(
    (tabId: string) => tabLeafView(sessionTabs.find((tab) => tab.id === tabId) ?? null) === 'chat',
    [sessionTabs, tabLeafView]
  )

  const setTabChatView = useCallback(
    (tabId: string, view: TerminalTabViewMode) => {
      if (!markerSession) {
        if (legacyIsTabChatView(tabId) !== (view === 'chat')) {
          legacyToggleTabChatView(tabId)
        }
        return
      }
      const row = terminalRows(sessionTabsRef.current).find((candidate) => candidate.id === tabId)
      if (!row) {
        return
      }
      getMobileChatPairWrites().submit(
        { hostId, worktreeId, parentTabId: chatViewParentTabId(row) },
        { viewMode: view, leafId: chatViewLeafId(row) },
        chatPairTargetForView(row, view)
      )
    },
    [
      hostId,
      legacyIsTabChatView,
      legacyToggleTabChatView,
      markerSession,
      sessionTabsRef,
      worktreeId
    ]
  )

  const retainedIdentity = useCallback(
    (tabId: string | null) => (tabId ? (retention.rows.get(tabId)?.identity ?? null) : null),
    [retention]
  )

  return { markerSession, tabLeafView, isTabChatView, setTabChatView, retainedIdentity }
}
