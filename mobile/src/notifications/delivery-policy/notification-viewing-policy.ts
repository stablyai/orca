import { AppState } from 'react-native'

type ViewedWorkspace = { worktreeId: string; executionHost?: string }

// `executionHost` is the route's server; absent for the desktop's own workspaces.
// A host document shows sessions inside itself, so on its route the session comes from what its page reports.
type Viewing = ({ hostId: string } & (ViewedWorkspace | { hostDocument: true })) | null
let viewing: Viewing = null
const hostDocumentSessions = new Map<string, ViewedWorkspace>()

export function setNotificationViewingWorkspace(value: Viewing): void {
  viewing = value
}

// A session route names its workspace; the host list's document can show one inside itself.
export function notificationViewingOfRoute(
  pathname: string,
  params: { hostId?: string; worktreeId?: string; executionHost?: string }
): Viewing {
  const { hostId, worktreeId, executionHost } = params
  if (typeof hostId !== 'string') {
    return null
  }
  if (pathname.includes('/session/') && typeof worktreeId === 'string') {
    return { hostId, worktreeId, ...(typeof executionHost === 'string' ? { executionHost } : {}) }
  }
  return /^\/h\/[^/]+$/.test(pathname) ? { hostId, hostDocument: true } : null
}

export function setHostDocumentSession(hostId: string, session: ViewedWorkspace | null): void {
  if (session === null) {
    hostDocumentSessions.delete(hostId)
  } else {
    hostDocumentSessions.set(hostId, session)
  }
}

// The session a page location names, or null for any other screen.
export function sessionOfPageLocation(href: string): ViewedWorkspace | null {
  const match = /^\/h\/[^/?]+\/session\/([^/?]+)(?:\?(.*))?$/.exec(href)
  if (match === null) {
    return null
  }
  try {
    const executionHost = new URLSearchParams(match[2] ?? '').get('executionHost')
    return {
      worktreeId: decodeURIComponent(match[1]!),
      ...(executionHost ? { executionHost } : {})
    }
  } catch {
    return null
  }
}

export function shouldSuppressNotificationWhileViewing(
  event: { worktreeId?: string; executionHost?: string },
  hostId: string,
  suppressWhileViewing: boolean
): boolean {
  if (!suppressWhileViewing || AppState.currentState !== 'active' || viewing?.hostId !== hostId) {
    return false
  }
  const shown = 'hostDocument' in viewing ? hostDocumentSessions.get(hostId) : viewing
  return (
    shown !== undefined &&
    shown.worktreeId === event.worktreeId &&
    shown.executionHost === event.executionHost
  )
}
