# Android window appearance

The shared appearance controller remains the only source of the effective theme.
This optional module applies that theme and its surface token to the native window
and navigation bar, including Activity foreground transitions and existing React
Native modal windows. Drawers refresh the native window after they are shown. It does not persist
settings or force an Activity restart. Older shells keep their existing behavior.

In System mode it also reads Android system resources directly, because React Native
can retain an old Activity/JS appearance cache across a background configuration
change. Manual preferences still use the shared controller. The query is optional
so older shells retain the React Native fallback.

System configuration changes and Activity foreground transitions also notify the
controller directly. This covers fast background/resume transitions that AppState
can coalesce before JS observes them. The application context reads the OS scheme
without the Activity-level manual override.
