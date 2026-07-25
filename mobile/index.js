// Dev-client entry bridge: our native build requests `index.android.bundle`,
// but this app's real entry is `expo-router/entry`. Re-export so Metro can
// resolve `./index` for the dev client over adb-reverse. Harmless for release.
import 'expo-router/entry'
