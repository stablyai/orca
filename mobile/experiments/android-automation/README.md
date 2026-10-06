# Android in-app engine automation proof

**Result: stock WebView CDP is viable for the tested core agent journey in a
non-debuggable APK on a production `user` Android emulator image.** The Activity
process connects directly to its own Chromium Unix socket; app commands do not
use adb, root, a TCP listener, a custom Chromium build, or simulated DOM input.
This is an experiment, not a production adapter or a claim of complete desktop
parity. No production files changed.

The security boundary is **same app UID plus Android shell/root**, not an
app-exclusive debugging endpoint. An unrelated app was denied, but an authorized
non-root adb connection could inspect and modify the page. If forbidding adb
attachment is a hard requirement, stock WebView's public API cannot meet it.
If the product accepts the ordinary device-owner debugging boundary, as desktop
already accepts local debugger exposure, engine reuse is the simplest next step.

## Measured environment and artifacts

2026-09-25, macOS arm64; dedicated headless API 36 **Google Play** arm64 emulator,
Android 16 `user/release-keys`, `ro.debuggable=0`, SELinux enforcing, stock Android
System WebView **133.0.6943.137**. Neither root nor `adb root` was used. APKs use
AGP 8.13.1, Gradle 9.0.0, JDK 17, compile/target 36, minimum 28, and release build
variants with `debuggable false`. They are signed with the local debug certificate
for installation convenience; that does not make the APK debuggable.

- [Run evidence](evidence/run.json): app results, identities, endpoint probes,
  desktop snapshot reuse, and cleanup receipts.
- [Engine accessibility tree](evidence/ax-tree.json) and
  [unchanged desktop snapshot output](evidence/desktop-snapshot.txt).
- [Engine screenshot](evidence/cdp-screenshot.png): the typed Unicode text and
  submitted result are visibly present; it was inspected after capture.
- [Source audit](evidence/source-audit.json): pinned official Chromium source URLs
  and SHA-256 digests of the inspected files.

The launcher runs in the main app process and opens a **non-exported native
Activity in `:route`**, with `setDataDirectorySuffix` before WebView initialization.
These are separate app processes sharing one UID, not Android isolated-UID
services. The engine client and scenario execute in the route process. The shell
process does not host another WebView or send the CDP commands.

All launched test processes used `ORCA_BACKGROUND_LAUNCH=1`; emulators used
`-no-window`, and no desktop app/window was focused. adb was used to install,
launch, collect evidence, perform an explicitly separate adversarial shell probe,
and clean up. It is not the in-app CDP command transport. Disabling device adb
while the journey runs was not tested.

## Operation evidence

| Operation      | Actual mechanism and result                                                                                                                                                                                                                                             | Limit                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Release access | Android `LocalSocket` connects to `webview_devtools_remote_<own PID>` in the abstract namespace; OkHttp handles HTTP/WebSocket framing.                                                                                                                                 | Socket name/discovery format is Chromium implementation behavior, not a versioned Android SDK automation API.                  |
| Enable/disable | Disabled startup rejects discovery; public `WebView.setWebContentsDebuggingEnabled(true)` enables it. Disabling again in the same live process rejects discovery; re-enabling permits external security probes. Disabled fresh-process restart leaves no debug sockets. | This control differs on a debug OS; see below.                                                                                 |
| Navigation     | A real engine-dispatched click follows an anchor to `second.html`; `Page.navigate` returns to `page.html?cdp=1`.                                                                                                                                                        | Local bundled pages, not remote HTTP, redirects, certificate errors, or cross-origin frames.                                   |
| Snapshot       | `Accessibility.enable` + `Accessibility.getFullAXTree` returns 15 nodes with actual engine roles/names.                                                                                                                                                                 | One document; frames, shadow DOM and large trees untested.                                                                     |
| Desktop reuse  | Existing `buildSnapshot(CdpCommandSender)` runs unchanged against this WebView and returns Customer, Submit order, Next page refs.                                                                                                                                      | This reuse check runs on the host through the separate adb probe; it is not yet a phone JS/runtime integration.                |
| Selectors      | `DOM.getDocument`, `DOM.querySelector`, `DOM.scrollIntoViewIfNeeded`, `DOM.getBoxModel` locate real nodes.                                                                                                                                                              | No stale-ref recovery or detached-node race test.                                                                              |
| Trusted click  | `Input.dispatchMouseEvent` down/up hits input and button; the page records `pointerdown`/`click` with `isTrusted=true` and active user activation.                                                                                                                      | Does not prove all gesture, drag, popup, permission or touch semantics.                                                        |
| Trusted text   | `Input.insertText` inserts `Orca agent 한글`; `beforeinput` and `input` are trusted; submission reads that exact value.                                                                                                                                                 | Text insertion, not physical key sequencing or arbitrary IME composition. Desktop `browser.type` also uses `Input.insertText`. |
| Screenshot     | `Page.captureScreenshot` produces a real 320×640 PNG containing the form and submitted result.                                                                                                                                                                          | Visible viewport only; background/stopped/locked Activity, full-page capture and PDF untested.                                 |

No `element.click()`, JavaScript value assignment, `dispatchEvent`, or rewritten
DOM accessibility tree supplies the interaction. The fixture records native
engine events; `Runtime.evaluate` only reads witnesses and page state. The
separate shell security probe deliberately writes one marker to prove arbitrary
inspection is more than discovery.

## Endpoint and security findings

| Caller/control              | Observation                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-debuggable app itself   | In-process Unix-socket HTTP discovery and WebSocket CDP work.                                                                                                                                                  |
| Unrelated installed APK     | Different UID; direct connection using the exact known socket name fails with `Permission denied`. Both fixture APKs use the same signing certificate, so a matching certificate alone does not grant access.  |
| Non-root Android shell/adbd | `uid=2000(shell)`, discovery succeeds via `adb forward`; `Runtime.evaluate` writes and returns `shell-owned`, then a separate evaluation reads back the same value.                                            |
| `run-as`                    | Refuses the app as not debuggable. CDP success is independent of `run-as` or the APK debug flag.                                                                                                               |
| Discovery                   | Shell sees the predictable PID-based name in `/proc/net/unix`. It is not secret or randomized.                                                                                                                 |
| Network endpoint            | This app opens no TCP listening socket. The HTTP host in discovery is framing over the fixed Unix socket, not a TCP connection. Only the adversarial host-side adb forward temporarily creates a TCP listener. |
| Permission ownership        | Chromium chooses an abstract socket and peer credential check, not an app-private filesystem path whose mode Orca can change.                                                                                  |

Official [WebView API documentation](<https://developer.android.com/reference/android/webkit/WebView#setWebContentsDebuggingEnabled(boolean)>)
allows explicit debugging and warns that it admits adb inspection. The pinned
[WebView server source](https://chromium.googlesource.com/chromium/src/+/refs/tags/133.0.6943.137/android_webview/browser/aw_devtools_server.cc)
chooses the abstract socket by default. Its
[credential predicate](https://chromium.googlesource.com/chromium/src/+/refs/tags/133.0.6943.137/content/browser/android/devtools_auth.cc)
accepts equal UID/GID for the server UID, shell, or root. The comment about signing
keys is imprecise: the implemented comparison is UID equality. Our unrelated-app
probe failed at connection with EACCES; it does not isolate the Chromium check
from SELinux. Source inspection supplies the additional credential-policy fact.
Root access is permitted by that source but was not empirically tested.

The public switch exposes no socket path, authentication callback or shell-denial
option. A private authenticated wrapper would not remove the underlying Chromium
socket, and changing filesystem permissions cannot protect an abstract name.
Temporarily enabling debugging narrows duration but does not remove shell access
while enabled. No reflection, provider patch, VPN or hidden API workaround is
proposed.

For comparison, desktop `src/main/browser/cdp-ws-proxy.ts` binds an ephemeral
`127.0.0.1` HTTP/WebSocket server and accepts connections without a token in that
module, then forwards to Electron's debugger. This is a source comparison, not a
new desktop penetration test. Android's UID/SELinux isolation rejects the tested
unrelated app, whereas desktop loopback is not intrinsically per-UID. Conversely,
Android's engine server is process-wide and exposes every WebView in that process;
the desktop proxy is constructed around one WebContents. Keep unrelated privileged
app-shell content out of a route process that enables this endpoint.

### Why a Google APIs emulator gave misleading disable results

The initial Google APIs image was `userdebug/dev-keys`, although the APK was
non-debuggable. Engine automation worked there, but disabled discovery also
worked, failing the negative control. WebView 133's
[SharedStatics](https://chromium.googlesource.com/chromium/src/+/refs/tags/133.0.6943.137/android_webview/glue/java/src/com/android/webview/chromium/SharedStatics.java)
and
[initialization](https://chromium.googlesource.com/chromium/src/+/refs/tags/133.0.6943.137/android_webview/glue/java/src/com/android/webview/chromium/WebViewChromiumAwInit.java)
force debugging on for debug Android/app builds and ignore this public toggle.
We switched to an already installed Google Play `user` image. The final runner
rejects `userdebug` images instead of weakening the disabled-endpoint assertions.

Other exploratory failures were fixture issues: OkHttp's cleartext policy check
(required an explicit localhost-only exception even though transport is Unix),
setting LocalSocket read timeout before connection, a native lint error in that
network policy XML, and expecting the literal errno spelling rather than Android's
`Connection refused` text. One launch hit the unchanged 30-second host-command
timeout (29.5 seconds reported by Android); it did not establish an engine failure.
The raw exploratory runs remain under `/tmp/orca-android-automation-proof`; final
committed evidence comes from the corrected source on the production user image.

## Smallest integration direction

The primary design was read from `5b296bc259:docs/mobile-client-hosted-browser-design.md`;
the earlier routing proof from `1a6f4454fd:mobile/experiments/android-route-processes/README.md`.
We reused its normal separate-Activity/data-suffix approach and host-runner safety
pattern, without importing its full SOCKS/Vite experiment or repeating its routing
claims. The page fixture is bundled to isolate automation from networking.

Keep `runtime-browser-client-automation.ts` and its existing owned-page, lease,
generation and result-ledger route. In a separately reviewed adapter PR, connect
the admitted page's native Activity to engine CDP through a small Unix transport
boundary. Reuse the portable desktop command algorithms around `CdpCommandSender`,
starting with the already-tested `snapshot-engine.ts` and native CDP input, rather
than porting the Electron `WebContents` facade or building a new DOM automation
system. Android `LocalSocket` and the public WebView toggle suffice for this proof;
OkHttp is the only experiment dependency and owns WebSocket protocol handling.

A first integrated slice should cover one explicitly phone-placed page, owned by
one native route Activity: open through the existing lease, navigate, snapshot,
click/type, screenshot, close. Keep its commands and results on existing paired
transport; no raw public CDP RPC, global TCP bridge or new agent CLI family. Bind
commands to the native page identity/generation, not arbitrary caller-supplied
socket names or target URLs. The experiment asserts one target; a real multi-page
adapter must bind targets reliably rather than selecting discovery's first row.
This is a proposed seam, not measured Binder/Expo/remote-runtime integration.

Before advertising support, probe the installed provider's endpoint and required
methods and fail unsupported operations explicitly. Preserve desktop
`automation-v1` semantics; negotiate an optional method set for phones, including
nested `browser.exec` admission. Lease replay, cancellation, process death, stale
commands, capability changes, result budgets, iframe sessions, and Activity
suspension remain integration gates. Endpoint naming and WebView updates require
version coverage; one bundled old WebView is not a provider support policy.
Placement/control policy is separate from this engine experiment; implement the
coordinator's lease-local explicit new-page claim in its own review, not here.
SSH/WSL and folder routing remain owned by existing execution-host grants and
network tunnel code; this experiment neither implements nor weakens that boundary.

### Native input/eval comparison (not implemented or verified)

If an app-exclusive endpoint is ultimately required, a native adapter can avoid
enabling WebView debugging. The smallest candidate is `WebView.loadUrl` and
`evaluateJavascript`, view-local `MotionEvent` dispatch / `InputConnection` text,
and native view capture. Those APIs are not a drop-in CDP replacement: selector
queries via page JS are not engine AX snapshots, coordinate conversion and input
semantics need validation, and Android view/window capture has different lifecycle
constraints. See official [WebView](https://developer.android.com/reference/android/webkit/WebView),
[InputConnection](https://developer.android.com/reference/android/view/inputmethod/InputConnection),
and [PixelCopy](https://developer.android.com/reference/android/view/PixelCopy) APIs.
No trusted-event, snapshot or screenshot parity is claimed for this candidate.
Because real engine reuse passed and the coordinator accepts a comparison to
ordinary desktop/device-owner exposure, no parallel fallback was built.

## Reproduce

Prerequisites: repository Node dependencies; JDK 17, Gradle 9.0.0, Android SDK 36
and build tools; a host-compatible **Google Play** API 36 image. Use a new dedicated
AVD, never an existing user device. Set `JAVA_HOME`, `ANDROID_HOME` and put SDK
`emulator`, `platform-tools`, `cmdline-tools/latest/bin` on PATH. Choose an unused
even emulator port. The runner is cross-platform through repository `runProcess`;
on Windows use equivalent PowerShell environment assignments and executable paths.

POSIX example from repository root:

```sh
export ORCA_BACKGROUND_LAUNCH=1
export ANDROID_AVD_HOME="$(mktemp -d)"
printf 'no\n' | avdmanager create avd -n OrcaAutomationUserProof -k 'system-images;android-36;google_apis_playstore;arm64-v8a'
emulator -avd OrcaAutomationUserProof -port 5690 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader -memory 2048 > /tmp/orca-automation-emulator.log 2>&1 &
export ANDROID_SERIAL=emulator-5690
adb -s "$ANDROID_SERIAL" wait-for-device
# Wait for 1 before continuing; ro.build.type must be user, ro.debuggable must be 0.
adb -s "$ANDROID_SERIAL" shell getprop sys.boot_completed
gradle -p mobile/experiments/android-automation --no-daemon :app:assembleRelease :outsider:assembleRelease
# Stop if the build failed; never run a stale APK.
pnpm exec esbuild mobile/experiments/android-automation/run-proof.ts --bundle --platform=node --packages=external --format=esm --tsconfig=mobile/experiments/android-automation/tsconfig.json --outfile=mobile/experiments/android-automation/build/run-proof.mjs
export ORCA_AUTOMATION_PROOF_DEDICATED=1
export ORCA_AUTOMATION_PROOF_OUTPUT=/tmp/orca-automation-results
node mobile/experiments/android-automation/build/run-proof.mjs
adb -s "$ANDROID_SERIAL" emu kill
# After emulator exit, delete only the dedicated AVD created above.
avdmanager delete avd -n OrcaAutomationUserProof
```

The runner refuses pre-existing fixture APKs, requires an emulator and explicit
ownership/background attestation, uses 30-second bounded host commands and bounded
CDP waits, and uninstalls only its two packages in `finally`. The adversarial adb
forward uses an OS-allocated port and removes exactly that mapping. An externally
killed runner may require manual cleanup of its packages/mapping. The caller owns
the emulator. Artifacts contain only bundled fixture content, no user browsing.

Focused checks:

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm --dir mobile typecheck
ORCA_BACKGROUND_LAUNCH=1 pnpm --dir mobile check:tests-typecheck
ORCA_BACKGROUND_LAUNCH=1 pnpm --dir mobile typecheck:android-automation-proof
ORCA_BACKGROUND_LAUNCH=1 pnpm --dir mobile test scripts/android-automation-witnesses.test.ts
ORCA_BACKGROUND_LAUNCH=1 pnpm exec oxlint mobile/experiments/android-automation/run-proof.ts
ORCA_BACKGROUND_LAUNCH=1 pnpm exec oxfmt --check mobile/experiments/android-automation
ORCA_BACKGROUND_LAUNCH=1 pnpm run check:code-quality:changed
```

This proof does not launch Electron, the Expo app, real SSH/relay routes, or a full
agent CLI session. It does not measure performance or prove broad platform
compatibility. Independent review and an integrated journey remain required;
no push or PR is part of this task.

## Validation and cleanup of the final run

The independent review found a mobile typecheck regression and two security-check
false positives. The runner now has a dedicated strict Node program and mobile CI
command; both React Native programs exclude only this experiment. Node types are
explicitly pinned; the DOM library remains for the unchanged portable snapshot
builder's renderer-yield branch. No production timers or test baseline changed.
The app and experiment typechecks pass. The full test program still reports its
existing errors; the test typecheck ratchet passes with no new failing files.

Both shell evaluations require no CDP exception and the exact string
`shell-owned`. The outsider must report a different numeric UID, the exact socket
for the current route PID, `connected: false`, no read result, and exactly
`java.io.IOException: Permission denied`. The subsequent shell positive control
uses that same socket. Connection refusal, EOF, timeouts and arbitrary exceptions
do not establish isolation. This still witnesses Android connect denial, not an
isolated test of Chromium's credential predicate.

The corrected release build and outsider release lint passed, as did 18 focused
witness tests, lint, formatting and the changed-code quality gate. The normal
headless Google Play API 36 user-image scenario passed; committed `run.json` and
screenshot now come from that corrected run. The screenshot was visually inspected.

Two separately generated, ignored runner variants repeat the reviewer's negative
controls without adding production flags: one replaces only the mutation with a
throwing expression, and one replaces only the outsider socket argument with
`review-no-such-socket`. Their results are recorded in
[negative controls](evidence/negative-controls.json). Each must exit 1, omit a
successful verdict and fail at its intended witness assertion, with cleanup
receipts. Deterministic tests also reject refusal at the correct name and an
incorrect name even when its reported error is permission denial.

All three runs remove both fixture packages and any allocated adb forward. The
dedicated `OrcaAutomationFix` emulator is stopped and its AVD deleted after the
runs; independent package, forward and socket queries verify cleanup. Only ignored
build outputs and `/tmp` evidence/logs remain. No production integration, parallel
fallback, push or PR is included; a fresh independent delta review is still needed.
