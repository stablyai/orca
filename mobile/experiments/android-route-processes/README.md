# Android process-specific browser routes: experiment

**Result: the two-process mechanism works on the tested Android emulator.** Two
native Activities in one APK independently loaded `http://localhost:5173/` through
separate SOCKS5 routes. Both received real Vite hot updates, including the stopped
Activity while the other screen was foregrounded. This removes the design proposal's
assumption that a process-wide proxy necessarily limits the entire app to one route.
It does not establish desktop automation parity or approve a production allocator.

## What was run

2026-09-25, macOS arm64; a newly created, dedicated API 36 Google APIs arm64 emulator,
Android System WebView **133.0.6943.137**, AndroidX WebKit **1.14.0** (the version
already used by `mobile/modules/orca-mobile-web-shell`). Native build: JDK 17,
Gradle 9.0.0, Android Gradle Plugin 8.13.1, compile/target API 36, minimum API 28.
All tests/apps used `ORCA_BACKGROUND_LAUNCH=1`; emulator used `-no-window`.
No physical device or existing emulator was modified.

The main mobile app uses Expo/React Native; its native web shell already owns a
WebView, while `mobile-browser-command-operations.ts` sends browser commands to the
existing host. This experiment is a separate APK, with no production code changes.
It reuses the repository's `RemoteBrowserSocksServer`, `runProcess`, Vite, esbuild,
TypeScript and lint tools. It does not reproduce SOCKS parsing or add a tunnel.

The supplied design commit did not contain the named document. The coordinator
provided the proposal through orchestration, which was read before the experiment.

## Observations

[evidence.json](./evidence.json) retains route reports, SOCKS targets, lifecycle logs,
event timestamps, memory readings and cleanup receipts from the measured pass.
Earlier-run logcat lines and unrelated emulator process listings were omitted.

| Check                           | Actual observation                                                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate app processes          | A PID **5740**, B PID **5854**, same APK; manifest `:route_a` / `:route_b`. These are app PIDs, not just WebView renderer PIDs.                                                                    |
| Identical URL, separate routing | Every report used `http://localhost:5173/`; SOCKS CONNECT targets were `localhost:5173`. A served route `a`, B served route `b`.                                                                   |
| Concurrent fetch                | Each route delivered at least three interval fetch reports in the same post-load observation window.                                                                                               |
| Concurrent real HMR             | Editing both Vite modules to revisions 2 and 3 produced each route's `hmr` report through Vite's WebSocket without reloading either document.                                                      |
| Screen switching                | `am start` switched A → B → A → B; lifecycle logs show stop/resume and retained PIDs/documents. No Activity embedding or custom compositor.                                                        |
| Process death                   | `run-as dev.orca.routeproof kill -9 5740` terminated only A; process table confirmed its absence, B retained PID 5854 and received revision 4.                                                     |
| Recovery                        | Starting A created PID **6046**, loaded current revision 3, then accepted revision 4 over HMR. B did not reload.                                                                                   |
| Storage                         | Both initially saw empty cookies/localStorage. Each wrote and continued reading its own route value at the identical origin. Restarted A read its persisted `a` values.                            |
| Memory                          | App-process PSS snapshots: A **69,940 KiB**, B **75,909 KiB** (about 142 MiB combined). Renderer memory is **not included**; these are single snapshots, not marginal cost or a production budget. |

The measured pass completed the scenario in about 5.4 seconds after A's first
observed load. This is not a cold-start latency benchmark: it excludes install,
boot, and some startup, and uses local transport. An earlier full pass also passed.
Initial fixture attempts failed because macOS temporary-directory symlinks confused
Vite's module paths; resolving the fixture root with `realpath` fixed that setup.

## Limits of the evidence

- **Two execution hosts are simulated:** two independent Vite servers on this Mac,
  behind separate SOCKS instances. `adb reverse` supplies each emulator-loopback
  proxy endpoint; each SOCKS opener maps the identical target to its own Vite port.
  This tests WebView process/proxy isolation, not remote machine identity, SSH,
  relay encryption, production tunnel multiplexing, or physical-phone networking.
- Only short screen switches while the app was in use were tested. No locked-phone,
  Doze, memory-pressure eviction, long background residence, or OEM lifecycle test.
- Only localStorage and cookies were tested. IndexedDB, service workers, cache
  partitioning, downloads, popups, file upload, HTTPS certificates, WebRTC/UDP leaks,
  and comprehensive network fail-closed behavior remain untested.
- Recovery was explicit relaunch after app-process SIGKILL. No automatic recovery,
  renderer-crash handling, stale-command fencing, or main-shell crash was tested.
- The Activities use fixed route identities and a fixed two-process manifest.
  Dynamic route reassignment, multiple pages per route and RN/Expo integration
  remain unimplemented. App processes share an Android UID: this is browser data
  separation, not a security boundary between hostile native code.
- No CDP, trusted input, agent protocol, or desktop automation parity was tested.
  Debug-WebView tooling is not evidence of a deployable production automation API.

## Simplest production direction, if pursued

Use Android's normal full-screen Activities in a **small explicit bounded set of
manifest processes**, with a stable browser-data identity for each execution
route/profile. Wait for the proxy callback before any page navigation, and call
`setDataDirectorySuffix` before any WebView/provider initialization in that process.
The experiment uses a stable suffix per fixed route; a production slot number must
not become the data identity when a slot is reassigned to another host.

Start with an explicit concurrent-route limit rather than an unbounded allocator.
When replacing a route, terminate its old process before selecting another data
suffix or proxy. The evidence does not justify implementing eviction, migration,
remote surfaces, or a general broker now. Avoid booting the full RN/Expo runtime in
each route process without measuring it; the standalone app measurements exclude it.

A normal Binder/Messenger connection could carry bounded lifecycle and automation
commands between shell and route Activity; that is an **untested design option**.
It still requires death handling and stale-generation rejection. Native Activity
switching is observed; product back navigation, a shared tab strip, transitions,
keyboard integration and accessibility are untested. A native full-screen browser
screen is simpler to investigate next than cross-process view embedding.

| Alternative                                        | Comparison                                                                                                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One process, one proxy, switch active route        | Least native lifecycle code, but cannot preserve two independently routed live documents at the same URL. Existing connections and subsequent requests also complicate switching. Not equivalent to the requirement. |
| AndroidX profiles in one process                   | Useful storage separation; the tested WebKit API's proxy controller is process-specific, not a per-profile route. It does not remove this network-routing conflict.                                                  |
| One local HTTP gateway with unique ports/hostnames | Can multiplex routes, but changes origin/URL and can require rewriting dev-server WebSocket or redirect behavior. Does not preserve the stated same-origin requirement.                                              |
| Request interception                               | Introduces a replacement network stack and does not provide general WebSocket interception; less durable than the platform proxy for real HMR.                                                                       |
| VPN or external browser                            | Adds device-level permission/routing and lifecycle ownership; same-destination route ambiguity and automation ownership still need solving. Not a simpler drop-in.                                                   |
| Existing server-hosted browser                     | Already owns desktop browser automation and background execution; simplest way to retain those capabilities today, with the current streamed interaction tradeoff.                                                   |
| Two fixed Activity processes                       | Observed solution to concurrent same-URL routing, at a measurable memory cost; broader product integration remains work.                                                                                             |

Recommendation: **go for bounded Android native-routing feasibility; no-go for a
claim of desktop-parity mobile browsing/automation based on this experiment alone.**
Keep the server-hosted path available. Independent review and an integration spike
covering lifecycle, real remote routes and automation are needed before production
architecture is committed.

Platform references: [process-specific proxy](https://developer.android.com/reference/androidx/webkit/ProxyController),
[SOCKS rules and localhost bypass removal](https://developer.android.com/reference/androidx/webkit/ProxyConfig.Builder),
[data-directory ownership](https://developer.android.com/reference/androidx/webkit/ProcessGlobalConfig),
[profile API](https://developer.android.com/reference/androidx/webkit/Profile).

## Reproduce

Use a **new dedicated headless emulator**, never an existing user device. Installed
SDK platform/build tools 36, a matching emulator image, JDK 17, Gradle 9.0.0, and
repository Node dependencies are prerequisites. Export `JAVA_HOME`, `ANDROID_HOME`,
and put SDK `platform-tools`, `emulator`, `cmdline-tools/latest/bin` on PATH.
On Windows use PowerShell environment assignment and the corresponding executables;
the TS runner itself uses the repository's cross-platform process launcher.

POSIX example, from repository root (choose an unused even emulator port):

```sh
export ORCA_BACKGROUND_LAUNCH=1
export ANDROID_AVD_HOME="$(mktemp -d)"
printf 'no\n' | avdmanager create avd -n OrcaRouteProof -k 'system-images;android-36;google_apis;arm64-v8a'
emulator -avd OrcaRouteProof -port 5560 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader -memory 2048 > /tmp/orca-route-emulator.log 2>&1 &
export ANDROID_SERIAL=emulator-5560
adb -s "$ANDROID_SERIAL" wait-for-device
# Wait until this prints 1 before continuing.
adb -s "$ANDROID_SERIAL" shell getprop sys.boot_completed
gradle -p mobile/experiments/android-route-processes --no-daemon :app:assembleDebug
pnpm exec esbuild mobile/experiments/android-route-processes/run-proof.ts --bundle --platform=node --packages=external --format=esm --tsconfig=mobile/experiments/android-route-processes/tsconfig.json --outfile=mobile/experiments/android-route-processes/build/run-proof.mjs
export ORCA_ROUTE_PROOF_DEDICATED=1
export ORCA_ROUTE_PROOF_EVIDENCE=/tmp/orca-route-evidence.json
node mobile/experiments/android-route-processes/build/run-proof.mjs
adb -s "$ANDROID_SERIAL" emu kill
# Delete only the dedicated AVD created above, after the emulator exits.
avdmanager delete avd -n OrcaRouteProof
```

Use a host-compatible image ABI (e.g. x86_64 on an x86_64 host). `ADB` may be set to
an absolute adb executable path. The runner rejects non-emulator serials, requires
explicit dedicated-emulator attestation, and refuses a pre-existing test package.
It installs only `dev.orca.routeproof`, kills only that package's route A via
`run-as`, then uninstalls it, removes only its own reverse mappings, closes both
Vite/SOCKS servers, and deletes their temporary fixture directories. It records
cleanup errors and exits nonzero on failures. An externally killed runner may need
manual cleanup of these experiment-owned resources; the emulator is caller-owned.

Focused static checks:

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm --dir mobile run typecheck:android-route-proof
ORCA_BACKGROUND_LAUNCH=1 pnpm exec oxlint mobile/experiments/android-route-processes/*.ts
```

## Validation and cleanup for this run

Native `:app:assembleDebug`, the two complete emulator scenarios, focused TypeScript,
oxlint and formatting checks, `git diff --check`, and
`pnpm run check:code-quality:changed` passed. The changed-code gate reported zero
new findings. This isolated harness does not run the Expo application or its test
suite. No PR was opened; independent review remains the coordinator's next gate.

The runner's uninstall and both reverse-map removals succeeded, verified again with
`pm list packages` and `adb reverse --list`. Both Vite/SOCKS routes closed and their
temporary fixture directories were deleted. The dedicated emulator process exited
with code 0 after `adb -s emulator-5640 emu kill`; `avdmanager delete avd` removed
only the newly created `OrcaRouteProof` AVD. Build outputs remain ignored for review
and reruns; temporary build/emulator logs remain under `/tmp`.

## Review corrections and counterexamples

The harness now waits for Android's resumed Activity and fresh PID-qualified
resume/stop lifecycle messages on each switch. It checks single-load document
identity before and after return switches, including fresh page reports, before
editing HMR modules or killing A. `am start -W` waits for initial process launch.
Reverse mappings use `--no-rebind`; only successful acquisitions enter cleanup.
Route construction also unwinds partial setup and attempts every cleanup step.

[review-evidence.json](./review-evidence.json) records the corrected harness run on
another new dedicated headless API 36 emulator (`OrcaProofFix`, emulator-5682).
It retains reports, events, current-run lifecycle lines and cleanup receipts;
older logcat entries and unrelated process/memory dumps are omitted.

- Normal native proof: passed, A PID 6951, B PID 7079, recovered A PID 7303.
- Reviewer's no-op third/fourth-start fixture: exit 1 at `a resumed; b stopped`,
  before revision 3 or process death. Background HMR no longer proves switching.
- Collision before the first acquisition: refused; `tcp:64264 -> tcp:9` survived.
- Collision before the second acquisition: refused; `tcp:64306 -> tcp:9` survived,
  while the acquired first mapping on 64301 was removed. The fixture owner then
  removed its injected mappings. The collision wrapper recognizes `--no-rebind`
  but forwards it unchanged to adb.
- Injected SOCKS setup rejection after Vite started: fixture directory removed and
  probe exited naturally without a live Vite listener.

An additional fourth-start-only no-op probe was **inconclusive**: three attempts
rejected a second B document load before reaching that injection. This is retained
as an unexplained fixture/native observation, not a switch counterexample or a
host timeout, and no acceptance assertion was relaxed. Independent follow-up
review should investigate it. Raw runs and wrappers remain in
`/tmp/orca-proof-fix`, including the exploratory launch/parser failures corrected
before the final normal run. The 30-second environment timeout is unchanged.

Native build, focused TypeScript/oxlint/formatting, changed-code quality and diff
checks passed. Package and reverse-map queries were empty after cleanup; the
headless emulator exited 0 and its dedicated AVD was deleted. No PR was opened;
independent follow-up review remains required.

### Fixture startup correction

Independent tracing resolved the earlier duplicate B load: delayed initial
`index.html` writes reached Vite's watcher after startup, queuing a full reload
before B connected. The fixture now excludes that exact immutable HTML path from
watching; `revision.js` remains watched. No delay, retry, or load-count relaxation
is needed.

[watcher-evidence.json](./watcher-evidence.json) retains a controlled before/after
regression and the native validation summary. Rewriting identical HTML before the
first WebSocket connection queued and delivered a real full reload on the old
fixture; the corrected fixture ignored it. Both fixtures still emitted real Vite
module updates when `revision.js` changed. The corrected normal Android scenario
passed, and both directional no-op controls reached their intended lifecycle
assertion with one load per document. Each scenario ran once after emulator boot;
a separate pre-boot invocation stopped before installation or route creation.
Raw evidence and the reproduction driver remain under `/tmp/orca-watcher-fix`.
Independent focused re-review is still required before publication.
