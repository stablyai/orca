import { readNativeNotificationData } from './native-notification-data'
import { readOrcaPushPayload } from './push-payload'

export type ConsumedNotificationTarget = Readonly<{
  id?: string
  osNotificationIdentifier?: string
  notificationId?: string
  hostId?: string
  hostFingerprint?: string
  worktreeId?: string
  paneKey?: string
  executionHost?: string
}>

const CONSUMED_TTL_MS = 15_000
const consumedIdentifiers = new Map<string, number>()

function pruneExpiredConsumed(now = Date.now()): void {
  for (const [key, expiresAt] of consumedIdentifiers) {
    if (expiresAt <= now) {
      consumedIdentifiers.delete(key)
    }
  }
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

export function markNotificationTargetConsumed(target: ConsumedNotificationTarget): void {
  const now = Date.now()
  pruneExpiredConsumed(now)
  const expiresAt = now + CONSUMED_TTL_MS
  if (target.osNotificationIdentifier) {
    consumedIdentifiers.set(`os:${target.osNotificationIdentifier}`, expiresAt)
  }
  if (target.notificationId) {
    consumedIdentifiers.set(`nid:${target.notificationId}`, expiresAt)
  }
  if (target.id) {
    consumedIdentifiers.set(`os:${target.id}`, expiresAt)
  }
}

export function isNotificationTargetConsumed(target: {
  osNotificationIdentifier?: string
  notificationId?: string
}): boolean {
  pruneExpiredConsumed()
  if (
    target.osNotificationIdentifier &&
    consumedIdentifiers.has(`os:${target.osNotificationIdentifier}`)
  ) {
    return true
  }
  if (target.notificationId && consumedIdentifiers.has(`nid:${target.notificationId}`)) {
    return true
  }
  return false
}

export function resetConsumedNotificationsForTests(): void {
  consumedIdentifiers.clear()
}

function matchesNotificationTarget(
  identifier: string,
  rawData: unknown,
  target: ConsumedNotificationTarget,
  excludeIdentifier?: string
): boolean {
  if (excludeIdentifier && identifier === excludeIdentifier) {
    return false
  }
  if (target.osNotificationIdentifier && identifier === target.osNotificationIdentifier) {
    return true
  }
  if (target.id && identifier === target.id) {
    return true
  }
  const payload = readOrcaPushPayload(rawData)
  const record =
    rawData && typeof rawData === 'object' ? (rawData as Record<string, unknown>) : null
  const dataHostId = typeof record?.hostId === 'string' ? record.hostId : undefined
  const dataNotificationId =
    payload?.notificationId ??
    (typeof record?.notificationId === 'string' ? record.notificationId : undefined)
  const dataWorktreeId =
    payload?.worktreeId ?? (typeof record?.worktreeId === 'string' ? record.worktreeId : undefined)
  const dataPaneKey =
    payload?.paneKey ?? (typeof record?.paneKey === 'string' ? record.paneKey : undefined)

  if (
    target.notificationId &&
    dataNotificationId &&
    paramMatches(dataNotificationId, target.notificationId)
  ) {
    return true
  }

  if (!target.worktreeId || !dataWorktreeId || !paramMatches(dataWorktreeId, target.worktreeId)) {
    return false
  }

  const hostMatches =
    (target.hostId && dataHostId && paramMatches(dataHostId, target.hostId)) ||
    (target.hostFingerprint &&
      payload?.hostFingerprint &&
      payload.hostFingerprint === target.hostFingerprint) ||
    (!target.hostId && !target.hostFingerprint)

  if (!hostMatches) {
    return false
  }

  if (target.paneKey) {
    return !dataPaneKey || paneKeyMatches(dataPaneKey, target.paneKey)
  }

  return true
}

async function sweepPresentedNotifications(
  target: ConsumedNotificationTarget,
  excludeIdentifier?: string
): Promise<void> {
  const Notifications = await import('expo-notifications').catch(() => null)
  if (!Notifications) {
    return
  }
  const dismissFn =
    'dismissNotificationAsync' in Notifications &&
    typeof Notifications.dismissNotificationAsync === 'function'
      ? Notifications.dismissNotificationAsync
      : null
  if (!dismissFn) {
    return
  }
  if (!excludeIdentifier && target.osNotificationIdentifier) {
    await dismissFn(target.osNotificationIdentifier).catch(() => {})
  }
  const getPresentedFn =
    'getPresentedNotificationsAsync' in Notifications &&
    typeof Notifications.getPresentedNotificationsAsync === 'function'
      ? Notifications.getPresentedNotificationsAsync
      : null
  if (!getPresentedFn) {
    return
  }
  const presented = await getPresentedFn().catch(() => [])
  if (!Array.isArray(presented)) {
    return
  }
  await Promise.all(
    presented.map(async (notification) => {
      const identifier = notification?.request?.identifier
      if (typeof identifier !== 'string' || identifier.length === 0) {
        return
      }
      const rawData = readNativeNotificationData(notification.request)
      if (matchesNotificationTarget(identifier, rawData, target, excludeIdentifier)) {
        await dismissFn(identifier).catch(() => {})
      }
    })
  )
}

export async function dismissConsumedTrayNotifications(
  target: ConsumedNotificationTarget
): Promise<void> {
  markNotificationTargetConsumed(target)
  await sweepPresentedNotifications(target)
  // Why: Android's ExpoPresentationDelegate posts notifications on Dispatchers.IO
  // after foregroundNotificationBehavior resolves. A second sweep catches a tray
  // card that finished posting right as the user tapped the in-app capsule.
  const followUpTimer = setTimeout(() => {
    void sweepPresentedNotifications(target)
  }, 400)
  const maybeTimer = followUpTimer as unknown as { unref?: () => void }
  if (typeof maybeTimer.unref === 'function') {
    maybeTimer.unref()
  }
}

export async function dismissSupersededPaneTrayNotifications(
  target: ConsumedNotificationTarget,
  keepIdentifier: string
): Promise<void> {
  if (!target.worktreeId || !target.paneKey) {
    return
  }
  await sweepPresentedNotifications(target, keepIdentifier)
}
