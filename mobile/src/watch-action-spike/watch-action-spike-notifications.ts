import * as Notifications from 'expo-notifications'
import {
  WATCH_ACTION_SPIKE_ACTIONS,
  WATCH_ACTION_SPIKE_CATEGORY
} from './watch-action-spike-config'
import type { WatchActionSpikeResult } from './watch-action-spike-results'

// Spike copy stays English: these notifications exist only in ORCA_WATCH_SPIKE builds.
// Yes is first and nondestructive so Watch Double Tap approves; no action requires an unlocked phone.
export function registerWatchActionSpikeCategory(): Promise<unknown> {
  return Notifications.setNotificationCategoryAsync(WATCH_ACTION_SPIKE_CATEGORY, [
    {
      identifier: WATCH_ACTION_SPIKE_ACTIONS.yes,
      buttonTitle: 'Yes',
      options: { opensAppToForeground: false }
    },
    {
      identifier: WATCH_ACTION_SPIKE_ACTIONS.no,
      buttonTitle: 'No',
      options: { opensAppToForeground: false }
    },
    {
      identifier: WATCH_ACTION_SPIKE_ACTIONS.reply,
      buttonTitle: 'Reply',
      textInput: { submitButtonTitle: 'Send', placeholder: 'Say a reply' },
      options: { opensAppToForeground: false }
    }
  ])
}

export async function armWatchActionSpike(hostId: string, delaySeconds: number): Promise<void> {
  await registerWatchActionSpikeCategory()
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Orca watch test',
      body: 'Claude wants to run: echo hello. Allow?',
      categoryIdentifier: WATCH_ACTION_SPIKE_CATEGORY,
      data: { orcaWatchSpike: { hostId, armedAt: Date.now() } },
      sound: 'default'
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: delaySeconds
    }
  })
}

// The result notification mirrors to the Watch too, closing the loop on the wrist.
export function postWatchActionSpikeResult(result: WatchActionSpikeResult): Promise<string> {
  const label = actionLabel(result.action)
  const title =
    result.outcome === 'reached'
      ? `✓ ${label} reached host in ${result.totalMs}ms`
      : result.outcome === 'stale'
        ? `${label} arrived ${Math.round((result.nativeToJsMs ?? 0) / 1000)}s late; not acted on`
        : `✗ ${label} failed at ${result.failedStep}`
  const body = [
    result.path ? `path ${result.path}` : null,
    `app ${result.appState}`,
    result.nativeToJsMs !== null ? `native→JS ${result.nativeToJsMs}ms` : 'no native record',
    result.replyText !== undefined ? `“${result.replyText}”` : null,
    result.steps[result.steps.length - 1]?.detail ?? null
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
  return Notifications.scheduleNotificationAsync({
    content: { title, body, data: { orcaWatchSpikeResult: true } },
    trigger: null
  })
}

function actionLabel(action: string): string {
  switch (action) {
    case WATCH_ACTION_SPIKE_ACTIONS.yes:
      return 'Yes'
    case WATCH_ACTION_SPIKE_ACTIONS.no:
      return 'No'
    case WATCH_ACTION_SPIKE_ACTIONS.reply:
      return 'Reply'
    default:
      return 'Tap'
  }
}
