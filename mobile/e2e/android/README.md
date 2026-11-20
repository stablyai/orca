# Mobile file-upload Android emulator E2E

Maestro flow for the terminal attach menu (Select from Gallery, Files). Android twin of `../simulator/file-upload.yaml`.

## Setup

- Env: `export ANDROID_HOME=$HOME/Library/Android/sdk ANDROID_SDK_ROOT=$ANDROID_HOME JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home PATH=$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$JAVA_HOME/bin:$PATH` (JDK 17 for Gradle; Maestro runs fine on JDK 21).
- Emulator: `emulator -avd <avd> -no-window -no-audio -no-snapshot -gpu swiftshader_indirect -port 5572 &`, wait for `adb -s emulator-5572 shell getprop sys.boot_completed` = 1.
- App (package `dev.orca.app`): `cd mobile && pnpm native ensure android` (debug dev client; ~5 min cold). If no emulator is up when it reaches the install step it fails; install the built APK yourself: `adb -s emulator-5572 install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk`. An existing `dev.orca.app` with a different signature must be `adb uninstall`ed first.
- Metro: `pnpm start --dev-client --port 8081`, then `adb reverse tcp:8081 tcp:8081` and `adb shell am start -a android.intent.action.VIEW -d "exp+orca-mobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"`. Dismiss the system "nearby devices" permission (Allow) and the Expo dev-menu "Continue" sheet (back key closes it).
- Isolated desktop: `ORCA_BACKGROUND_LAUNCH=1 pnpm dev:fresh`; take `userData` from the `ORCA_DEV_INSTANCE` log line and `export ORCA_USER_DATA_PATH=<it>`. Then `orca repo add --path <dir>`, `orca terminal create --worktree path:<dir> --title e2e --json`, `orca pair --mobile --address 10.0.2.2 --json` (10.0.2.2 is the emulator's alias for the host). Open `result.pairingUrl` with `adb shell am start -a android.intent.action.VIEW -d '<url>'`, tap Pair, answer the onboarding prompts ("Keep terminal", "Not now"), run `orca terminal switch --terminal <handle>`, and in the app tap `main` so the terminal tab with the "Live input" strip is showing.
- Media: `adb push test-photo.png /sdcard/Pictures/`, `adb push test-clip.mp4 /sdcard/Movies/`, `adb push notes.json readme.txt /sdcard/Download/`, then `adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/test-photo.png` (and the mp4). The photo picker must show the video and the photo as its two newest items.

## Run

    maestro --device emulator-5572 test --test-output-dir=./out mobile/e2e/android/file-upload.yaml

Screenshots land in `./out/<timestamp>/file-upload/takeScreenshot/`.

## Verify on the host

Videos and documents stream into `<userData>/agent-session-attachments/<uuid>/<name>`; compare `shasum -a 256` with the sources. The gallery photo goes through the image-paste path (`orca-paste-*.png` in the OS temp dir) and is re-encoded, so its hash differs from the source (same 320x240 image). The terminal gets all paths typed in; check with `orca terminal read --terminal <handle>`. Clear `agent-session-attachments/*` between runs.

## Android differences

- App id is `dev.orca.app` (iOS: `com.stably.orca.mobile`).
- The attach button is inside the web view, which is not in the accessibility tree: it still needs a coordinate tap (81%,91%). Everything in the system pickers uses text selectors: the Photo Picker exposes tiles as content descriptions (`Video taken on...`, `Photo taken on...`, newest first) plus `Done`; Documents UI exposes file names, a long press starts multi-select ("2 selected"), then `Select`.
- No "Allow Full Access" step; the Photo Picker grants only the selected items.
- The adb-provisioned AVD had `font_scale` 2.0 (huge UI, header clipped); the flow passed with it. A dev-build debug banner (bundle hash) overlaps the bottom of the input strip but the attach button stays tappable.
- Do not write `uiautomator dump` output to `/sdcard`: it shows up in the Files picker.
