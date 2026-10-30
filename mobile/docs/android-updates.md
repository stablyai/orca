# Android in-app updates

Orca's existing release checker owns discovery, its daily cadence, manual checks and per-version
dismissals. Android APKs use the `mobile-android-v*` channel, including its published prereleases.
Desktop releases must not be used as Android update metadata.

Home and Settings now open an in-app update dialog. Downloading is explicit and cancellable.
“Keep using Orca” hides the dialog without stopping the transfer; reopening it restores progress.
The controller lives outside the screen, so navigation and rotation do not start a
second download. Process death stops the transfer. A subsequent download reuses a completed APK
only after verifying it again; an interrupted transfer restarts.

Before downloading, Orca refreshes the selected release and requires exactly one uploaded
`app-release.apk`, an exact Orca release URL, a positive size up to 512 MiB and GitHub's SHA-256
digest. The Android module streams to private cache, enforces the byte count and digest, then
checks the package name, exact version name, Android minimum and current installed signer set.
It requires a newer marketing version and a nondecreasing Android version code: historical Orca
APKs share version code 22. Same-version installs and downgrades are never offered.

“Install update” verifies the cached file again before granting temporary read-only access
through a non-exported FileProvider restricted to the updater's cache directory. Android owns
the final confirmation. If needed, Orca opens its install-source permission screen; granting
permission continues into the installer on return. Denying permission or cancelling installation
leaves the verified download available to retry. Orca never reports installation success just
because it opened the installer, and never uninstalls the app or clears paired hosts/settings.

The GitHub release page remains available for missing metadata, incompatible local signing keys,
network errors and managed-device policies. iOS keeps its App Store flow. Expo Go and older native
shells without the updater keep opening the release page.

The existing public-template signing key is a separate distribution issue tracked in #21808.
Matching that certificate checks install compatibility, not publisher authenticity. The exact
GitHub release URL and digest are required independently. This change does not rotate signing
keys or weaken the existing signer's compatibility check.

## Verification

From `mobile/`:

```sh
pnpm test src/app-update
pnpm typecheck
pnpm run check:tests-typecheck
pnpm lint
pnpm format:check
pnpm exec expo prebuild --platform android --no-install
cd android
./gradlew --no-configuration-cache :orca-app-updater:testDebugUnitTest :orca-app-updater:lintDebug :app:assembleRelease
```

The Android updater workflow runs the native unit tests and lint on changes to this module.
For end-to-end testing, build a local older marketing version with the same package and signing
certificate as a real newer published APK. Exercise download cancellation, navigation during
download, checksum/signature rejection, permission denial/grant, installer cancellation and
successful replacement. Reopen the app and check that its version changed and settings survived.

No Play services, storage permission, unattended install or silent self-update is needed.
