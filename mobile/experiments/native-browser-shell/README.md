# Disabled Android native browser seam

This fixture builds the **real Expo application and existing OrcaMobileWebShell
module**, replacing only the generated app's JS entrypoint. It is not a second
native proof app. No OTA screen imports or activates the adapter.

Production admission is disabled in native code. Only an explicit Gradle
`-PorcaBrowserFixture=true` build admits `openBrowserFixture`; ordinary builds
reject it. Fixture requests name an already listening `http://127.0.0.1:port`
proxy and four identity dimensions: authority, execution host, Orca profile, and
browser profile. Those fields are fixture assertions, **not authenticated host
route grants**. Actual host tunnel admission, proxy lifetime, capability
negotiation, automatic placement, and RPC registration remain separate work.
There is no fallback to direct phone networking if the proxy is unavailable.
This fixture does not establish full network isolation or WebRTC policy.

## Boundary and lifetime

- One application-scoped native owner binds one non-exported service in
  `:orca_browser`. Create does not launch an Activity. The service owns the page;
  explicit `resumeNativeBrowser` presents that same WebView in a separate-task
  Activity. Standard `onNewIntent` updates the presentation generation before
  attachment in the real `onResume`; this also handles presenting a reopened page.
  Stop detaches it and resets its mutable context to application scope.
  The guest process starts no RN runtime or OTA document. The startup guard
  preserves API 24–27 shell boot; guest admission requires API 28+.
- SHA-256 of a length-delimited JSON tuple of the four identity fields supplies
  the WebView data-directory suffix. The process position and proxy port are not
  profile identity. A different profile requires actual process death before
  another open. Cookies/storage are not cleared on close.
- Binder Messengers are passed explicitly between the same-app owner and guest;
  neither endpoint is exported. A generated page generation fences commands,
  close and resume. Binder death rejects pending commands and releases the slot.
  One command may be in flight. Startup, commands, and close confirmation are
  bounded; ambiguous startup fails closed rather than admitting another guest.
  A failed Binder send reports `guest_transport_unavailable`, never proves death,
  and never retries the request. Even a failed close retains the occupied slot
  until the registered death recipient fires.
- Navigation, evaluation, AX, engine input and software viewport capture work
  without presentation. No synthetic resume/focus calls, invisible Activity,
  overlay, foreground service or additional process pool is used. A pure bound
  service has Android-managed lifetime; there is no guarantee against OS eviction.
- The native owner retains application context, never React context. Each Expo
  module owns a separate headless task in its existing RN runtime; module teardown
  stops that task without closing the page. A replacement module uses the occupied
  native lease, so it cannot reassign the profile. Actual page close/death settles
  the tasks; late task tokens cannot bind to a replacement task. Explicit close is
  required to release a page; killing the shell process also ends the guest.
- OkHttp 4.9.2 is already in React Native's release runtime dependency graph.
  Its socket factory can connect only to this guest process's abstract Unix
  WebView socket. Discovery must contain exactly one page at the generated
  initial marker before attaching. No TCP CDP listener, caller-specified socket,
  arbitrary target selection, or public raw-CDP RPC is added.
- Commands are navigation, by-value evaluation, engine AX tree, **software viewport PNG**,
  engine pointer click and text insertion. Native request strings are capped at
  64 Ki characters and replies at 240,000 characters, below Binder's shared
  transaction limit; the caps cannot reserve space in the shared buffer.
  Capture returns `captureKind: "software-viewport"`, bitmap width/height, and page
  generation. It uses ordinary `WebView.draw(Canvas(bitmap))`, caps allocation at
  8 million pixels, and recycles the bitmap. CDP `Page.captureScreenshot` timed out
  on the detached WebView in the feasibility probe. This is not compositor capture:
  video, WebGL/hardware layers, full-document capture and pixel parity are unproved.
  Large screenshots fail explicitly; this is not a streaming
  file channel. Evaluation exceptions reject, rather than looking successful.
- Enabling WebView debugging exposes its normal same-UID and device-owner shell
  access on stock Android. The wrapper cannot make Chromium's socket app-exclusive.
  No claim of desktop automation parity, ref-action routing, iframe coverage,
  compositor screenshots, or multiple simultaneous routes is made.

## Reproduce (dedicated headless Android user-image emulator only)

Use JDK 17 and an installed Android SDK 36. Set `ORCA_BACKGROUND_LAUNCH=1` for
all builds, tests and launches. Create your own AVD and unused emulator port;
do not reuse or stop another worker's/user's device. A Google Play API 36 arm64
`user` image was used with `-no-window -no-audio -no-boot-anim -no-snapshot
-gpu swiftshader -memory 2048`. Set its display to 640x960 and density 160 for
the fixture's engine input coordinates. No desktop window is revealed.

1. Run `pnpm --dir mobile install --frozen-lockfile`, then
   `pnpm --dir mobile exec expo prebuild --platform android --no-install`.
2. In the **ignored generated** `mobile/android/app/build.gradle`, replace only
   the `react.entryFile` assignment with
   `entryFile = file("../../experiments/native-browser-shell/fixture.tsx")`.
   Do not change or commit the production `mobile/index.js`.
3. From `mobile/android`, run `./gradlew :app:assembleRelease
:orca-mobile-web-shell:testDebugUnitTest :orca-mobile-web-shell:lintRelease
-PorcaBrowserFixture=true -PreactNativeArchitectures=arm64-v8a --console=plain`
   (use `gradlew.bat` on Windows). This rebuilds the generated startup guard.
4. Start `python3 mobile/experiments/native-browser-shell/fixture-server.py
/absolute/evidence/directory` in the background. It binds loopback port 18779
   and serves only the fixed fixture page; unknown proxy destinations are refused.
5. On the dedicated emulator, install `mobile/android/app/build/outputs/apk/release/app-release.apk`,
   allocate `adb -s SERIAL reverse tcp:18779 tcp:18779`, and start
   `com.stably.orca.mobile/.MainActivity`. The collector must be reachable through
   emulator host address `10.0.2.2:18779`; it is not a production host route.
6. Require `passed.json` and absence of `failure.json` in a **fresh** evidence
   directory. Clear fixture app data first when repeating a failed reload run:
   its checkpoint intentionally survives React reload. The journey asserts shell
   window focus through background create/navigation/AX/trusted form submit/capture,
   same-document presentation/return, another trusted form submission after return, actual `reloadAppAsync` module replacement,
   rejected replacement open, retained nonce/value/storage, confirmed close/reopen,
   stale generation, pending-command failure on process death, and isolated storage
   for a changed execution host. The infinite-evaluation death probe does not prove
   Chromium entered the loop before termination. Check logcat's
   `OrcaBrowserFixture: module_destroyed <old moduleId>` against `beforeReload.json`.
   Capture checks generation/current document and the requested emulator viewport
   (640×960 physical and CSS pixels at density 160). Independently check PNG IHDR
   dimensions and visually inspect `backgroundScreenshot.png`,
   `returnedScreenshot.png`, and `screenshot.png`: each must contain the typed
   Korean text and saved form result. PNG existence alone is not successful capture.
7. Build again **without** `-PorcaBrowserFixture=true`, reinstall, and launch into
   another fresh evidence directory. Require `failure.json` to report
   `native_browser_admission_disabled` and no `:orca_browser` process. This checks
   the default gate through the actual Expo call, not only a source assertion.
8. Uninstall only this fixture package from the dedicated emulator, remove only
   its `tcp:18779` reverse, stop your collector and emulator, and remove only your
   AVD. Restore the generated entrypoint or rerun a clean prebuild before normal
   application development. Nothing is pushed by this workflow.

Additional checks: `node --test mobile/plugins/android-browser-process.test.cjs`,
`pnpm --dir mobile typecheck`, `pnpm --dir mobile check:tests-typecheck`, and the
repository changed-code quality gate. Native route unit tests cover every
profile dimension, stable identity across proxy ports, loopback admission and
rejection of native-resource navigation schemes.

## Lifecycle regression checks and activation gates

`ORCA_BACKGROUND_LAUNCH=1 ./gradlew :orca-mobile-web-shell:testBrowserLifecycle`
from `mobile/android` compiles the real owner, React task and module-session
implementation against deterministic Android/RN boundary doubles. The 19 scenarios
cover live-endpoint transaction errors, retained occupied profiles, actual death,
no replay, ambiguous/refused binds, background command without Activity launch,
service disconnection without death, module/task replacement, presentation close,
startup timeout and stale generations. Stale commands and presentation requests must
preserve the current React task/token and native page after confirmed close/reopen;
session startup validates the existing native lease on the main queue before mutation.
These are not Android ordering or Chromium
simulations; the release fixture supplies the separate measured journey.

Production admission stays disabled. This proves a bounded form journey on one
API 36 user image / WebView 133 provider, including a real React reload. It does not
prove long suspension, OS eviction recovery, configuration recreation, all hardware
rendering, provider coverage, full automation parity, network isolation, authenticated
route grants, relay/SSH transport, or placement. The four route dimensions and
fixture proxy are unchanged; changing host identity is a storage-isolation witness,
not an actual SSH connection. No host/mobile grant or default-placement code changes.

## Lifecycle choice and platform references

A single [bound service](https://developer.android.com/develop/background-work/services/bound-services)
is the standard bounded lifetime independent of presentation; Android destroys it
when its binding clients disappear. An application-scoped binding avoids tying the
page to a React module or transient Activity. The old process must still die before
profile reuse. A service-disconnection callback and a failed Binder send do not
release the lease. An explicit refused bind frees the unlaunched slot; an exception
from binding retains it because creation may be ambiguous.

[Offscreen preraster](<https://developer.android.com/reference/android/webkit/WebSettings#setOffscreenPreRaster(boolean)>)
is documented for window-attached views and is not a detached compositor solution.
The measured [View drawing](<https://developer.android.com/reference/android/view/View#draw(android.graphics.Canvas)>)
path supplies the narrow software bitmap operation instead. The Activity uses a
[mutable context](https://developer.android.com/reference/android/content/MutableContextWrapper)
only while it presents the page, then releases that Activity reference. The [Activity intent lifecycle](<https://developer.android.com/reference/android/app/Activity#onNewIntent(android.content.Intent)>)
requires explicitly saving a replacement intent; attachment waits for real resume
so a restored task cannot attach the previous generation. This choice
avoids always-on started/foreground services and display/focus tricks while keeping
its rendering limitations explicit.
