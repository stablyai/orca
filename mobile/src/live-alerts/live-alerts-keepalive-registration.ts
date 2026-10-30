import { AppRegistry, Platform } from 'react-native'
import { LIVE_ALERTS_KEEP_ALIVE_TASK, runLiveAlertsKeepAlive } from './live-alerts-keepalive-task'

// Imported only by index.js, before the router loads, so the native side can start the task as
// soon as the first notification is posted. Kept apart from the task module so screens and tests
// that import the watcher don't register anything.
if (Platform.OS === 'android') {
  AppRegistry.registerHeadlessTask(LIVE_ALERTS_KEEP_ALIVE_TASK, () => runLiveAlertsKeepAlive)
}
