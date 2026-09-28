const { withAndroidManifest, withAppBuildGradle } = require('expo/config-plugins')

// Why: the orca-local-runtime module is autolinked into every Android build, but only the
// standalone flavor may declare a long-running foreground service and battery exemptions —
// the store build must not ask for either. Non-standalone builds strip them at manifest merge.
const SERVICE = 'expo.modules.orcalocalruntime.LocalRuntimeService'
// FOREGROUND_SERVICE and WAKE_LOCK stay: other libraries request them, and removal is global.
const STANDALONE_ONLY_PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS'
]

// Why 28: from targetSdk 29 SELinux forbids executing files an app wrote to its own data dir, and the
// guest userland is exactly that. expo-build-properties refuses anything below 31, hence the gradle edit.
const STANDALONE_TARGET_SDK = 28

function withStandaloneTargetSdk(config) {
  return withAppBuildGradle(config, (cfg) => {
    const pinned = `targetSdkVersion ${STANDALONE_TARGET_SDK}`
    let contents = cfg.modResults.contents
    if (!contents.includes(pinned)) {
      const pattern = /targetSdkVersion rootProject\.ext\.targetSdkVersion/
      if (!pattern.test(contents)) {
        throw new Error(
          'android-local-runtime: targetSdkVersion line not found in app/build.gradle'
        )
      }
      contents = contents.replace(pattern, pinned)
    }
    // Release lint fails an expired targetSdk; this flavor is sideload-only by design. HardcodedDebugMode
    // is only hit by the opt-in debuggable dev build below.
    const lintBlock = "lint { disable 'ExpiredTargetSdkVersion', 'HardcodedDebugMode' }"
    if (!contents.includes(lintBlock)) {
      contents = contents.replace(/^android \{\n/m, `android {\n    ${lintBlock}\n`)
    }
    cfg.modResults.contents = contents
    return cfg
  })
}

module.exports = function withAndroidLocalRuntime(config, { standalone, debuggable }) {
  if (standalone) {
    config = withStandaloneTargetSdk(config)
  }
  return withAndroidManifest(config, (cfg) => {
    if (standalone) {
      // Dev only: `run-as` into the app is the one way to inspect the guest rootfs from adb.
      if (debuggable) {
        const application = cfg.modResults.manifest.application?.[0]
        if (application) {
          application.$['android:debuggable'] = 'true'
        }
      }
      return cfg
    }
    const manifest = cfg.modResults.manifest
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools'
    const permissions = (manifest['uses-permission'] ??= [])
    for (const name of STANDALONE_ONLY_PERMISSIONS) {
      if (!permissions.some((entry) => entry.$['android:name'] === name)) {
        permissions.push({ $: { 'android:name': name, 'tools:node': 'remove' } })
      }
    }
    const application = manifest.application?.[0]
    if (application) {
      const services = (application.service ??= [])
      services.push({ $: { 'android:name': SERVICE, 'tools:node': 'remove' } })
    }
    return cfg
  })
}
