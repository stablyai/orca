import * as Notifications from 'expo-notifications'
import { AppState } from 'react-native'
import { OrcaWatchActionSpike } from '../../modules/orca-watch-action-spike/src/index'
import {
  WATCH_ACTION_SPIKE_CATEGORY,
  WATCH_ACTION_SPIKE_STALE_MS,
  isWatchActionSpikeEnabled
} from './watch-action-spike-config'
import {
  postWatchActionSpikeResult,
  registerWatchActionSpikeCategory
} from './watch-action-spike-notifications'
import { appendWatchActionSpikeResult } from './watch-action-spike-results'
import {
  runWatchActionSpikeRoundTrip,
  type WatchActionSpikeRoundTrip
} from './watch-action-spike-round-trip'

const handledResponses = new Set<string>()

async function nativeTapAt(notificationId: string): Promise<number | null> {
  const events = (await OrcaWatchActionSpike?.readEvents().catch(() => null)) ?? []
  let at: number | null = null
  for (const event of events) {
    if (event.kind === 'response' && event.notificationId === notificationId) {
      at = event.at
    }
  }
  return at
}

function readSpikeHostId(data: unknown): string | null {
  const spike =
    typeof data === 'object' && data !== null && 'orcaWatchSpike' in data
      ? data.orcaWatchSpike
      : null
  return typeof spike === 'object' &&
    spike !== null &&
    'hostId' in spike &&
    typeof spike.hostId === 'string'
    ? spike.hostId
    : null
}

async function handleWatchActionSpikeResponse(
  response: Notifications.NotificationResponse
): Promise<void> {
  const { request } = response.notification
  if (
    request.content.categoryIdentifier !== WATCH_ACTION_SPIKE_CATEGORY ||
    response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER
  ) {
    return
  }
  const key = `${request.identifier}:${response.actionIdentifier}`
  if (handledResponses.has(key)) {
    return
  }
  handledResponses.add(key)
  const startedAt = Date.now()
  const appState = AppState.currentState
  const tappedAt = await nativeTapAt(request.identifier)
  const nativeToJsMs = tappedAt === null ? null : startedAt - tappedAt
  const hostId = readSpikeHostId(request.content.data)
  const base = {
    at: startedAt,
    action: response.actionIdentifier,
    ...(response.userText !== undefined ? { replyText: response.userText } : {}),
    appState,
    nativeToJsMs
  }
  try {
    if (nativeToJsMs !== null && nativeToJsMs > WATCH_ACTION_SPIKE_STALE_MS) {
      const result = { ...base, outcome: 'stale' as const, totalMs: 0, steps: [], log: [] }
      await appendWatchActionSpikeResult(result)
      await postWatchActionSpikeResult(result)
      return
    }
    const trip: WatchActionSpikeRoundTrip = hostId
      ? await runWatchActionSpikeRoundTrip(hostId)
      : { ok: false, failedStep: 'notification-data', steps: [], log: [] }
    const result = {
      ...base,
      outcome: trip.ok ? ('reached' as const) : ('failed' as const),
      ...(trip.failedStep ? { failedStep: trip.failedStep } : {}),
      ...(trip.path ? { path: trip.path } : {}),
      totalMs: Date.now() - startedAt,
      steps: trip.steps,
      log: trip.log
    }
    await appendWatchActionSpikeResult(result)
    await postWatchActionSpikeResult(result)
  } finally {
    await OrcaWatchActionSpike?.endHold().catch(() => undefined)
  }
}

// Call from the app entry after E2EE native bindings are provided: a replayed tap dials the host at once.
export function startWatchActionSpikeIfEnabled(): void {
  if (!isWatchActionSpikeEnabled()) {
    return
  }
  void registerWatchActionSpikeCategory().catch(() => undefined)
  Notifications.addNotificationResponseReceivedListener((response) => {
    void handleWatchActionSpikeResponse(response)
  })
  // A tap that launched this JS was replayed before the listener existed; Expo keeps only the last one.
  const pending = Notifications.getLastNotificationResponse()
  if (pending) {
    void handleWatchActionSpikeResponse(pending)
  }
}
