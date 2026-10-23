import { AppState } from 'react-native'
import {
  dismissInAppNotificationBanner,
  getCurrentInAppNotificationBanner
} from './in-app-notification-banner-store'

export type NotificationViewingWorkspace = Readonly<{
  hostId: string
  worktreeId: string
  paneKey?: string
  executionHost?: string
}>

// `executionHost` is the route's server; absent for the desktop's own workspaces.
let routeViewing: NotificationViewingWorkspace | null = null
let inPageViewing: NotificationViewingWorkspace | null = null

function paramMatches(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) {
    return false
  }
  if (actual === expected) {
    return true
  }
  try {
    return decodeURIComponent(actual) === expected
  } catch {
    return false
  }
}

function dismissBannerMatchingViewingWorkspace(): void {
  const banner = getCurrentInAppNotificationBanner()
  if (
    banner &&
    isViewingNotificationTarget({
      hostId: banner.hostId,
      worktreeId: banner.worktreeId,
      paneKey: banner.paneKey,
      executionHost: banner.executionHost
    })
  ) {
    dismissInAppNotificationBanner(banner.id)
  }
}

export function setNotificationViewingWorkspace(
  value: NotificationViewingWorkspace | null,
  options?: { preserveInPageForHostId?: string }
): void {
  routeViewing = value
  if (value === null) {
    if (
      !options?.preserveInPageForHostId ||
      !paramMatches(inPageViewing?.hostId, options.preserveInPageForHostId)
    ) {
      inPageViewing = null
    }
    return
  }
  if (inPageViewing && !paramMatches(inPageViewing.hostId, value.hostId)) {
    inPageViewing = null
  }
  dismissBannerMatchingViewingWorkspace()
}

export function setInPageNotificationViewingWorkspace(
  value: NotificationViewingWorkspace | null
): void {
  inPageViewing = value
  if (value !== null) {
    dismissBannerMatchingViewingWorkspace()
  }
}

export function getNotificationViewingWorkspace(): NotificationViewingWorkspace | null {
  return inPageViewing ?? routeViewing
}

export function isViewingWorkspaceTarget(target: {
  hostId?: string
  worktreeId?: string
  executionHost?: string
}): boolean {
  const viewing = getNotificationViewingWorkspace()
  if (!viewing || !target.hostId || !target.worktreeId) {
    return false
  }
  const viewingExec = viewing.executionHost || undefined
  const targetExec = target.executionHost || undefined
  const executionHostMatches =
    viewingExec === undefined && targetExec === undefined
      ? true
      : paramMatches(viewingExec, targetExec)
  return (
    paramMatches(viewing.hostId, target.hostId) &&
    paramMatches(viewing.worktreeId, target.worktreeId) &&
    executionHostMatches
  )
}

function paneKeyMatches(actual: string | undefined, expected: string | undefined): boolean {
  if (paramMatches(actual, expected)) {
    return true
  }
  if (!actual || !expected) {
    return false
  }
  const actualColon = actual.lastIndexOf(':')
  const expectedColon = expected.lastIndexOf(':')
  if (actualColon <= 0 || expectedColon <= 0) {
    return false
  }
  const actualLeaf = actual.slice(actualColon + 1)
  const expectedLeaf = expected.slice(expectedColon + 1)
  if (!actualLeaf || actualLeaf !== expectedLeaf) {
    return false
  }
  return (
    actual.startsWith('structured-agent-session-') ||
    expected.startsWith('structured-agent-session-')
  )
}

export function isViewingNotificationTarget(target: {
  hostId?: string
  worktreeId?: string
  paneKey?: string
  executionHost?: string
}): boolean {
  if (!isViewingWorkspaceTarget(target)) {
    return false
  }
  const viewing = getNotificationViewingWorkspace()
  if (!target.paneKey || !viewing?.paneKey) {
    return true
  }
  return paneKeyMatches(viewing.paneKey, target.paneKey)
}

export function shouldSuppressNotificationWhileViewing(
  event: { worktreeId?: string; paneKey?: string; executionHost?: string },
  hostId: string,
  suppressWhileViewing: boolean
): boolean {
  return (
    suppressWhileViewing &&
    AppState.currentState === 'active' &&
    isViewingNotificationTarget({
      hostId,
      worktreeId: event.worktreeId,
      paneKey: event.paneKey,
      executionHost: event.executionHost
    })
  )
}
