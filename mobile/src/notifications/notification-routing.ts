export type DesktopNotificationSource =
  | 'agent-task-complete'
  | 'terminal-bell'
  | 'test'
  | 'dispatch'

export type DesktopNotificationEvent = {
  source: DesktopNotificationSource
  worktreeId?: string
  /** Stable `${tabId}:${leafId}` pane key so the tap can focus the exact pane. */
  paneKey?: string
  notificationId?: string
}

export type LocalNotificationData = {
  source: DesktopNotificationSource
  hostId: string
  worktreeId?: string
  paneKey?: string
  notificationId?: string
}

export type NotificationNavigationOptions = {
  knownHostIds?: ReadonlySet<string>
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/**
 * Builds serializable tap-routing data for a local mobile notification.
 *
 * A mobile notification is shown by the app from a desktop runtime event, so
 * this keeps only the host/worktree/pane identifiers needed after the tap.
 */
export function buildLocalNotificationData(
  event: DesktopNotificationEvent,
  hostId: string
): LocalNotificationData {
  const data: LocalNotificationData = {
    source: event.source,
    hostId
  }
  if (event.worktreeId) {
    data.worktreeId = event.worktreeId
  }
  if (event.paneKey) {
    data.paneKey = event.paneKey
  }
  if (event.notificationId) {
    data.notificationId = event.notificationId
  }
  return data
}

/**
 * Resolves local notification data into the mobile route opened after a tap.
 *
 * Invalid or unknown-host payloads are ignored because notification data can
 * outlive the active host list or come from an older app version.
 */
export function getNotificationNavigationPath(
  data: unknown,
  options: NotificationNavigationOptions = {}
): string | null {
  if (!data || typeof data !== 'object') {
    return null
  }

  const record = data as Record<string, unknown>
  const hostId = readNonEmptyString(record.hostId)
  if (!hostId) {
    return null
  }
  if (options.knownHostIds && !options.knownHostIds.has(hostId)) {
    return null
  }

  const hostPath = `/h/${encodeURIComponent(hostId)}`
  const worktreeId = readNonEmptyString(record.worktreeId)
  if (!worktreeId) {
    return hostPath
  }

  const sessionPath = `${hostPath}/session/${encodeURIComponent(worktreeId)}`
  // Why: a `dispatch`/agent notification can name the exact pane. Carry it as a
  // query param so the session screen can focus that split on load; taps
  // without a pane keep the plain worktree-granular route.
  const paneKey = readNonEmptyString(record.paneKey)
  return paneKey ? `${sessionPath}?pane=${encodeURIComponent(paneKey)}` : sessionPath
}
