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

- The existing Expo module owns one native guest at a time. A non-exported
  Activity runs in `:orca_browser`, with a separate task so returning to the
  single-task main shell does not destroy the guest. No additional RN runtime
  or OTA document starts there. The prebuild plugin guards only that exact
  process and preserves API 24–27 main-shell boot; guest admission requires 28+.
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
- Guest pause preserves its document and rejects new commands as
  `guest_not_foreground`. Explicit `resumeNativeBrowser` waits for actual native
  resume. The standard RN headless-task API keeps the **existing shell runtime**
  usable while the guest is resumed; pause, close, death, launch failure and
  module teardown finish it. Per-task tokens fence delayed JS task callbacks
  across pause/resume. This is not a foreground/background Android service or
  a guarantee against OS process eviction. Activity destruction ends this slice's
  page; configuration-recreation restoration is not implemented.
- OkHttp 4.9.2 is already in React Native's release runtime dependency graph.
  Its socket factory can connect only to this guest process's abstract Unix
  WebView socket. Discovery must contain exactly one page at the generated
  initial marker before attaching. No TCP CDP listener, caller-specified socket,
  arbitrary target selection, or public raw-CDP RPC is added.
- Commands are navigation, by-value evaluation, engine AX tree, viewport PNG,
  engine pointer click and text insertion. Native request strings are capped at
  64 Ki characters and replies at 240,000 characters, below Binder's shared
  transaction limit; the caps cannot reserve space in the shared buffer.
  Large screenshots fail explicitly; this is not a streaming
  file channel. Evaluation exceptions reject, rather than looking successful.
- Enabling WebView debugging exposes its normal same-UID and device-owner shell
  access on stock Android. The wrapper cannot make Chromium's socket app-exclusive.
  No claim of desktop automation parity, ref-action routing, iframe coverage,
  background screenshots, or multiple simultaneous routes is made.

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
/absolute/evidence/directory` in the background. It binds loopback port 18769
   and serves only the fixed fixture page; unknown proxy destinations are refused.
5. On the dedicated emulator, install `mobile/android/app/build/outputs/apk/release/app-release.apk`,
   allocate `adb -s SERIAL reverse tcp:18769 tcp:18769`, and start
   `com.stably.orca.mobile/.MainActivity`. The collector must be reachable through
   emulator host address `10.0.2.2:18769`; it is not a production host route.
6. Require `passed.json` and absence of `failure.json` in a **fresh** evidence
   directory. The fixture checks open, proxy navigation, AX, trusted text input,
   shell switch, unavailable command while paused, resume retaining typed state,
   screenshot, evaluation exception, close, fresh process/generation with stable
   profile, stale-generation rejection, in-flight command failure on explicit
   fixture process death, changed execution-host profile, and shell survival.
   Open `screenshot.png` and inspect the typed text. The AX response can be fed to
   the existing desktop snapshot builder without changing the builder; that is
   a conversion check, not proof of on-phone ref actions.
7. Build again **without** `-PorcaBrowserFixture=true`, reinstall, and launch into
   another fresh evidence directory. Require `failure.json` to report
   `native_browser_admission_disabled` and no `:orca_browser` process. This checks
   the default gate through the actual Expo call, not only a source assertion.
8. Uninstall only this fixture package from the dedicated emulator, remove only
   its `tcp:18769` reverse, stop your collector and emulator, and remove only your
   AVD. Restore the generated entrypoint or rerun a clean prebuild before normal
   application development. Nothing is pushed by this workflow.

Additional checks: `node --test mobile/plugins/android-browser-process.test.cjs`,
`pnpm --dir mobile typecheck`, `pnpm --dir mobile check:tests-typecheck`, and the
repository changed-code quality gate. Native route unit tests cover every
profile dimension, stable identity across proxy ports, loopback admission and
rejection of native-resource navigation schemes.

## Lifecycle regression checks and activation gates

`ORCA_BACKGROUND_LAUNCH=1 ./gradlew :orca-mobile-web-shell:testBrowserLifecycle`
from `mobile/android` compiles the actual `BrowserGuestOwner.kt` and
`BrowserGuestReactTask.kt` against deterministic Android/RN boundary doubles.
`testDebugUnitTest` also runs it. The suite injects live-endpoint transaction and
dead-object errors, checks no replay or premature profile reuse, distinguishes
close failure from death confirmation, preserves launch errors, and checks
resume teardown, task tokens, startup timeout and stale generations. It does not
simulate kernel buffer pressure, Android task ordering, Chromium or React reload;
route parsing is stubbed here and covered by the native route unit tests.

**Production activation remains blocked on replacement-owner lifetime proof.**
Each Expo module constructs its own owner; `OnDestroy` only posts retirement.
A replacement module can therefore have an empty lease while the old guest is
still alive, and the single-task Activity has no replacement-owner handshake in
`onNewIntent`. The per-owner tests cannot establish Android ordering or make
that process-wide ownership safe. Before enabling the seam, test actual React
reload/open racing old-owner teardown and establish process-wide ownership until
confirmed death. This change retains the default-disabled build gate and does
not claim to solve that race.

Hidden creation and commands while paused also remain activation gates: this
fixture always launches a foreground Activity and rejects every command while
stopped. Decoupling page lifetime from presentation and choosing the matching
same-runtime task lifetime require a separate design and Android proof.
