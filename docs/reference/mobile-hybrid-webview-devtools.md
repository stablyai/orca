# Inspecting the Android hybrid WebView with Chrome DevTools

The hybrid Android build renders the hosted React Native Web page inside a native
`MobileWebShellView` WebView. That WebView is normally not inspectable, even in a
release build made for dogfooding, because
`WebView.setWebContentsDebuggingEnabled` is driven by a policy that requires both a
debug build and the OS `ApplicationInfo.FLAG_DEBUGGABLE` flag.

This runbook covers the opt-in that makes a **release** APK inspectable while keeping
the release JS bundle, the hybrid architecture, and the same application id, so it
upgrades a dogfood install in place.

## The opt-in

A single Gradle property, `-PorcaInspectableRelease=true`, drives both halves:

- `mobile/plugins/android-inspectable-release.js` marks the release variant
  `debuggable`, which sets `FLAG_DEBUGGABLE` on the installed package and makes
  Android publish a `webview_devtools_remote_<pid>` abstract socket for the process.
  `mobile/android/` is generated and gitignored, so this lives in an Expo config
  plugin and is reapplied on every `expo prebuild`.
- `mobile/packages/expo-mobile-web-shell/android/build.gradle` sets the
  `ORCA_INSPECTABLE_RELEASE` build config field that
  `MobileWebInspectionPolicy.kt` reads.

Both default to `false`. A normal release build is unchanged and stays
uninspectable.

The policy keeps `FLAG_DEBUGGABLE` as a hard requirement:

```kotlin
return isDebuggable && (isDebugBuild || isInspectableRelease)
```

so a production APK signed and shipped without `debuggable` can never be inspected,
whatever the Gradle property said at build time. The loopback end-to-end security
probe stays `BuildConfig.DEBUG`-only and is not installed in an inspectable release.

## Build

The Expo module is consumed through a pnpm `file:` dependency, which is a **copy**,
not a symlink. Edits under `mobile/packages/expo-mobile-web-shell/` do not reach the
Gradle build until that copy is refreshed:

```bash
cd mobile
rsync -a --exclude 'build/' \
  packages/expo-mobile-web-shell/android/ \
  node_modules/@orca/expo-mobile-web-shell/android/
```

Then build:

```bash
cd mobile/android
EXPO_PUBLIC_ORCA_MOBILE_ARCHITECTURE=hybrid NODE_ENV=production \
  ./gradlew --rerun-tasks -PorcaInspectableRelease=true \
  :app:createBundleReleaseJsAndAssets :app:assembleRelease -q
```

The APK lands at `mobile/android/app/build/outputs/apk/release/app-release.apk`.

Confirm it is still a production hybrid bundle and that the manifest is debuggable:

```bash
cd mobile/android/app/build/outputs/apk/release
unzip -p app-release.apk assets/index.android.bundle | rg -c connectionLog
aapt dump badging app-release.apk | rg "application-debuggable|package: name"
```

## Install and launch

The phone occasionally drops off adb, so wait for a stable device before installing:

```bash
until adb devices | rg -q "^<serial>\s+device$"; do sleep 1; done
adb -s <serial> install -r mobile/android/app/build/outputs/apk/release/app-release.apk
adb -s <serial> shell monkey -p com.stably.orca.mobile.ota 1
```

Verify the OS agrees the package is debuggable:

```bash
adb -s <serial> shell dumpsys package com.stably.orca.mobile.ota | rg flags
```

The `flags=` line must contain `DEBUGGABLE`.

## Forward and attach

The socket does not exist at app launch. `MobileWebShellView` only calls
`setWebContentsDebuggingEnabled` when a session activates, so open a workspace on the
phone first, then look for the socket. On the home screen you will see other apps'
sockets and no `webview_devtools_remote_<pid>` entry for Orca.

Android names the DevTools socket after the process id, so read it rather than
guessing:

```bash
adb -s <serial> shell cat /proc/net/unix | rg devtools_remote
adb -s <serial> forward tcp:<port> localabstract:webview_devtools_remote_<pid>
curl -s http://127.0.0.1:<port>/json
```

Ports `9345` and `9444` are taken by other Orca tooling; pick something else.

The hosted page appears as a target whose URL is on the private asset origin,
`https://<session>.orca-mobile-web.invalid/#<session>`. Its `webSocketDebuggerUrl`
is the CDP endpoint.

Attach either way:

- **Chrome**: open `chrome://inspect`, add `127.0.0.1:<port>` under *Discover network
  targets*, then click *inspect* on the hosted target.
- **playwright-cli**: `playwright-cli attach --cdp http://127.0.0.1:<port>`.

Tear the forward down with `adb -s <serial> forward --remove tcp:<port>`.

Note that the socket name changes whenever the app process restarts, so re-read
`/proc/net/unix` and re-forward after a cold start.

## Verifying the default is still closed

A build without the property must produce no `android:debuggable` attribute and a
false build config field:

```bash
cd mobile/android
./gradlew --rerun-tasks :app:processReleaseMainManifest \
  :orca-expo-mobile-web-shell:generateReleaseBuildConfig -q
grep -o 'android:debuggable="[^"]*"' \
  app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml
grep ORCA_INSPECTABLE_RELEASE \
  ../node_modules/@orca/expo-mobile-web-shell/android/build/generated/source/buildConfig/release/expo/modules/mobilewebshell/BuildConfig.java
```

The first `grep` must find nothing and the second must report `= false`. Note this
overwrites the release intermediates, so rebuild with the property before shipping an
inspectable APK again.

## Gates

```bash
pnpm test mobile/src/mobile-web/hosted-webview-cdp-session.test.ts
pnpm test mobile/src/mobile-web/hosted-android-inspectable-release.test.ts
cd mobile && npx tsc --noEmit -p .
pnpm run check:code-quality:changed
```

The Kotlin truth table for the policy lives in
`mobile/packages/expo-mobile-web-shell/android/src/test/java/expo/modules/mobilewebshell/MobileWebInspectionPolicyTest.kt`
and runs with the module's `testDebugUnitTest` task.
