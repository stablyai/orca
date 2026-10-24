import { AppState } from 'react-native'
import { isTerminalLeafId } from '../../../src/shared/stable-pane-id'
import { registerBridgeSessionViewingSink } from './bridge-session-viewing-tracker'
import { dismissConsumedTrayNotifications } from './consumed-notification-tray-dismissal'
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
let lastLoggedViewing = ''

// Why: suppression bugs are only diagnosable on-device, so every effective change is one logcat line.
function logViewingChange(source: string): void {
  const line = `route=${JSON.stringify(routeViewing)} inPage=${JSON.stringify(inPageViewing)}`
  if (line !== lastLoggedViewing) {
    lastLoggedViewing = line
    console.info(`[notif-viewing] ${source} ${line}`)
  }
}

export function describeNotificationViewing(): string {
  return `appState=${AppState.currentState} route=${JSON.stringify(routeViewing)} inPage=${JSON.stringify(inPageViewing)}`
}

function normalizeParam(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function paramMatches(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) {
    return false
  }
  return actual === expected || normalizeParam(actual) === normalizeParam(expected)
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
    void dismissConsumedTrayNotifications(banner)
  }
}

export function setNotificationViewingWorkspace(
  value: NotificationViewingWorkspace | null,
  options?: { preserveInPageForHostId?: string }
): void {
  const wasRouteViewing = routeViewing
  routeViewing = value
  if (value === null) {
    if (
      wasRouteViewing !== null ||
      !options?.preserveInPageForHostId ||
      !paramMatches(inPageViewing?.hostId, options.preserveInPageForHostId)
    ) {
      inPageViewing = null
    }
    logViewingChange('route')
    return
  }
  if (
    inPageViewing &&
    (!paramMatches(inPageViewing.hostId, value.hostId) ||
      !paramMatches(inPageViewing.worktreeId, value.worktreeId))
  ) {
    inPageViewing = null
  }
  logViewingChange('route')
  dismissBannerMatchingViewingWorkspace()
  void dismissConsumedTrayNotifications(value)
}

export function setInPageNotificationViewingWorkspace(
  value: NotificationViewingWorkspace | null
): void {
  inPageViewing = value
  logViewingChange('inPage')
  if (value !== null) {
    dismissBannerMatchingViewingWorkspace()
    void dismissConsumedTrayNotifications(value)
  }
}

registerBridgeSessionViewingSink(setInPageNotificationViewingWorkspace)

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
  if (actual.startsWith('terminal:') || expected.startsWith('terminal:')) {
    const terminalId = (actual.startsWith('terminal:') ? actual : expected).slice(
      'terminal:'.length
    )
    const other = actual.startsWith('terminal:') ? expected : actual
    const otherColon = other.indexOf(':')
    if (otherColon > 0 && paramMatches(terminalId, other.slice(0, otherColon))) {
      return true
    }
  }
  const actualFirstColon = actual.indexOf(':')
  const expectedFirstColon = expected.indexOf(':')
  if (actualFirstColon > 0 && expectedFirstColon > 0) {
    const actualTabId = actual.slice(0, actualFirstColon)
    const expectedTabId = expected.slice(0, expectedFirstColon)
    const actualSuffix = actual.slice(actualFirstColon + 1)
    const expectedSuffix = expected.slice(expectedFirstColon + 1)
    if (
      paramMatches(actualTabId, expectedTabId) &&
      (!isTerminalLeafId(actualSuffix) || !isTerminalLeafId(expectedSuffix))
    ) {
      return true
    }
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
