// Why: first, so the stored palette choice is known before any module builds its styles.
import './src/theme/true-black-startup'
// Headless notification launches do not mount the router layout.
import './src/notifications/push-background-dismissal'
import 'expo-router/entry'
