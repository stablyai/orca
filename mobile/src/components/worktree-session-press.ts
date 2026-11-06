import { useRef } from 'react'
import type { AccessibilityActionEvent } from 'react-native'
import {
  setSelectedSidebarSession,
  useSelectedSidebarSession
} from '../host-screen/selected-sidebar-session'

type SessionRowTarget = {
  worktreeId: string
  isActive?: boolean
}

// The session row is nested in the workspace pressable. Claim its touch so that press cannot replace it.
export function useWorktreeSessionPress(onPress: () => void): {
  claim: () => void
  release: () => void
  press: () => void
  isClaimed: () => boolean
} {
  const claimed = useRef(false)
  const onPressRef = useRef(onPress)
  onPressRef.current = onPress
  const handlers = useRef({
    claim: () => {
      claimed.current = true
    },
    release: () => {
      setTimeout(() => {
        claimed.current = false
      }, 0)
    },
    press: () => {
      if (claimed.current) {
        claimed.current = false
        return
      }
      onPressRef.current()
    },
    isClaimed: () => claimed.current
  })
  return handlers.current
}

// Remember the tapped session and keep the workspace press from treating that touch as its own.
export function useWorktreeRowSession<T extends SessionRowTarget>(
  item: T,
  selectable: boolean,
  onPress: (item: T) => void,
  onAgentPress?: (item: T, paneKey: string) => void
): {
  claim: () => void
  release: () => void
  press: () => void
  isClaimed: () => boolean
  highlightedPane: string | null
  openAgent?: (paneKey: string) => void
  openWorkspace: () => void
  cardLongPress: (
    onLongPress: ((item: T) => void) | undefined,
    impact: () => void
  ) => (() => void) | undefined
  sessionLongPress: (
    onSessionLongPress: ((item: T, paneKey: string) => void) | undefined,
    impact: () => void
  ) => ((paneKey: string) => void) | undefined
} {
  const selected = useSelectedSidebarSession()
  const sessionPress = useWorktreeSessionPress(() => {
    setSelectedSidebarSession(null)
    onPress(item)
  })
  let highlightedPane: string | null = null
  if (selectable && item.isActive && selected?.worktreeId === item.worktreeId) {
    highlightedPane = selected.paneKey
  }
  const openAgent = onAgentPress
    ? (paneKey: string) => {
        setSelectedSidebarSession({ worktreeId: item.worktreeId, paneKey })
        onAgentPress(item, paneKey)
      }
    : undefined
  // The session row claims the touch, so the card's press handler would drop this tap.
  const openWorkspace = () => {
    setSelectedSidebarSession(null)
    onPress(item)
  }
  return {
    ...sessionPress,
    highlightedPane,
    openAgent,
    openWorkspace,
    cardLongPress: (onLongPress, impact) =>
      workspaceCardLongPress(sessionPress.isClaimed, onLongPress, item, impact),
    sessionLongPress: (onSessionLongPress, impact) =>
      sessionRowLongPress(sessionPress.claim, onSessionLongPress, item, impact)
  }
}

// The card Pressable is not an accessibility element, so the header is the workspace control.
export function workspaceCardActivation(disabled: boolean, onActivate: () => void) {
  const activate = () => {
    if (!disabled) {
      onActivate()
    }
  }
  return {
    accessible: true,
    accessibilityRole: 'button' as const,
    accessibilityState: disabled ? { disabled: true } : undefined,
    accessibilityActions: [{ name: 'activate' }],
    onAccessibilityTap: activate,
    onAccessibilityAction: (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'activate') {
        activate()
      }
    }
  }
}

function workspaceCardLongPress<T>(
  claimed: () => boolean,
  onLongPress: ((item: T) => void) | undefined,
  item: T,
  impact: () => void
): (() => void) | undefined {
  if (!onLongPress) {
    return undefined
  }
  return () => {
    // A session row claimed this touch, so its menu is the one that applies.
    if (claimed()) {
      return
    }
    impact()
    onLongPress(item)
  }
}

function sessionRowLongPress<T>(
  claim: () => void,
  onSessionLongPress: ((item: T, paneKey: string) => void) | undefined,
  item: T,
  impact: () => void
): ((paneKey: string) => void) | undefined {
  if (!onSessionLongPress) {
    return undefined
  }
  return (paneKey: string) => {
    claim()
    impact()
    onSessionLongPress(item, paneKey)
  }
}
