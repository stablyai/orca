// Why this file exists: a bare "expo-notifications" plugin entry writes
// `aps-environment: development` into the iOS entitlements, while push-token.ts
// reports `production` for every non-__DEV__ build. A TestFlight or App Store build
// would then register a production APNs token against a sandbox entitlement, and the
// gateway's pushes would be accepted by Apple and delivered nowhere. Deriving the
// mode from an env var the release workflow sets makes the two agree by construction
// instead of relying on the export step to rewrite the entitlement.
//
// app.json stays the source for everything else: Expo reads it first and hands it to
// this function, so the fastlane version/buildNumber rewrite still flows through.
const APS_ENVIRONMENT =
  process.env.ORCA_IOS_APS_ENVIRONMENT === 'production' ? 'production' : 'development'

// The standalone flavor runs its own Orca host (Ubuntu under proot) on the phone. It is a separate
// sideloaded app: targetSdk 28 is what lets it exec the rootfs binaries it unpacks into app data,
// which Play will not accept, so it must never share the store build's applicationId.
const ANDROID_STANDALONE = process.env.ORCA_ANDROID_STANDALONE === '1'

function withStandaloneBuildProperties(plugin) {
  if (!ANDROID_STANDALONE || !Array.isArray(plugin) || plugin[0] !== 'expo-build-properties') {
    return plugin
  }
  const [name, options] = plugin
  return [
    name,
    {
      ...options,
      android: { ...options.android, buildArchs: ['arm64-v8a'] }
    }
  ]
}

module.exports = ({ config }) => {
  const android = ANDROID_STANDALONE
    ? {
        ...config.android,
        package: 'com.stably.orca.standalone',
        // google-services.json has no client for this applicationId; push is desktop-relayed only.
        googleServicesFile: undefined
      }
    : config.android
  return {
    ...config,
    ...(ANDROID_STANDALONE ? { name: 'Orca Standalone' } : {}),
    android,
    extra: {
      ...config.extra,
      orcaAndroidStandalone: ANDROID_STANDALONE,
      // Dev builds only: lets chrome://inspect attach to the desktop-UI WebView.
      orcaWebViewDebugging: process.env.ORCA_ANDROID_DEBUGGABLE === '1'
    },
    ios: {
      ...config.ios,
      entitlements: { ...config.ios?.entitlements, 'aps-environment': APS_ENVIRONMENT }
    },
    plugins: [
      ...(config.plugins ?? []).map((plugin) =>
        plugin === 'expo-notifications'
          ? [
              'expo-notifications',
              {
                enableBackgroundRemoteNotifications: true,
                mode: APS_ENVIRONMENT,
                icon: './assets/notification-icon.png'
              }
            ]
          : withStandaloneBuildProperties(plugin)
      ),
      [
        './plugins/android-local-runtime.js',
        { standalone: ANDROID_STANDALONE, debuggable: process.env.ORCA_ANDROID_DEBUGGABLE === '1' }
      ]
    ]
  }
}
