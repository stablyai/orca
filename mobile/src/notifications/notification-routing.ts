export type DesktopNotificationSource = 'agent-task-complete' | 'terminal-bell' | 'test'

export type DesktopNotificationEvent = {
  source: DesktopNotificationSource
  worktreeId?: string
}

export type LocalNotificationData = {
  source: DesktopNotificationSource
  hostId: string
  worktreeId?: string
}

export type NotificationNavigationOptions = {
  knownHostIds?: ReadonlySet<string>
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

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
  return data
}

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

  return `${hostPath}/session/${encodeURIComponent(worktreeId)}`
}
