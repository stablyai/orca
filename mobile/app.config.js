// Bare expo-notifications defaults to sandbox entitlements while non-dev push-token.ts reports production, silently losing TestFlight/App Store pushes.
// Derive APNs mode from release workflow env; Expo still supplies app.json, including Fastlane version/buildNumber rewrites, for everything else.
const APS_ENVIRONMENT =
  process.env.ORCA_IOS_APS_ENVIRONMENT === 'production' ? 'production' : 'development'

module.exports = ({ config }) => ({
  ...config,
  // `expo run` installs a dev-client build cached for the current native fingerprint instead of
  // rebuilding; scripts/native-client.mjs populates the cache.
  buildCacheProvider: { plugin: './scripts/native-build-cache.cjs' },
  // Watch action spike: only builds made with ORCA_WATCH_SPIKE=1 register its category and Troubleshoot row.
  extra: { ...config.extra, orcaWatchSpike: process.env.ORCA_WATCH_SPIKE === '1' },
  ios: {
    ...config.ios,
    // Watch action spike: lets a developer sign a device build under their own Apple team.
    bundleIdentifier: process.env.ORCA_IOS_BUNDLE_ID || config.ios?.bundleIdentifier,
    entitlements: { ...config.ios?.entitlements, 'aps-environment': APS_ENVIRONMENT }
  },
  plugins: (config.plugins ?? []).map((plugin) =>
    plugin === 'expo-notifications'
      ? [
          'expo-notifications',
          {
            enableBackgroundRemoteNotifications: true,
            mode: APS_ENVIRONMENT,
            icon: './assets/notification-icon.png'
          }
        ]
      : plugin
  )
})
