import 'expo-task-manager'
import { AppRegistry, Platform } from 'react-native'

if (Platform.OS === 'android') {
  // TaskService finishes this task when its work settles; resolving it here pauses background timers.
  AppRegistry.registerHeadlessTask('expo-task-manager', () => () => new Promise<void>(() => {}))
}
