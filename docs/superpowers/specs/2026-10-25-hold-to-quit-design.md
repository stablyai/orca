# Hold to quit while agents work

Status: implemented and source/hidden-renderer/universal-build validated; physical
positive-hold and packaged permission/signing limits are recorded below.

## Requirements and decisions

The user requires an optional setting that prevents an accidental macOS Cmd+Q from
quitting Orca while agents work. A continuous hold quits through the existing route;
once work finishes, a fresh short Cmd+Q quits normally.

The user additionally requires the first busy tap to explain immediately that
holding is necessary because agents are still working. The upstream English hint
is **Agents are still working. Hold ⌘Q to quit.** Progress follows the genuine
continuous hold, while release immediately cancels quitting. The hint remains
readable after a short tap; it is never added to chat history or a timeline.

The coordinator chose a default-off switch labelled **Hold ⌘Q while agents are
working**, a fixed 1000 ms hold, a roughly two-second explanatory hint after
release, and quiet existing nonmodal UI primitives. These are implementation
choices, not additional user requirements.
There is no duration picker, confirmation dialog, Cmd+W protection, double press,
extra modifier, global keyboard monitor, or new dependency in this candidate.

Only the keyboard shortcut is guarded. Explicit menu/Dock Quit, updater/relaunch,
signals, process shutdown and serve-host policies keep their existing routes.
Linux, Windows and mobile do not gain this control or changed quit behavior.

## Existing boundaries

- `src/main/menu/app-menu-quit-item.ts` currently supplies the native quit role,
  or a custom menu callback with CmdOrCtrl+Q for persistent serve hosts.
- `src/main/startup/main-process-i18n-menu.ts` currently injects the custom user
  Quit callback only for serve mode.
- `src/main/startup/main-window-actions.ts` owns `quitFromUserCommand`; serve mode
  closes desktop windows, while ordinary desktop mode calls `app.quit()`.
- `process-quit-request.ts`, `main-process-quit.ts` and
  `serve-native-quit-guard.ts` own process intent, teardown and native serve-host
  behavior. Hold detection must run before these boundaries, with no new
  `before-quit` veto.
- `main-window-shortcut-routing.ts` mirrors shortcut-recorder and terminal
  ownership. Browser guests have their own `before-input-event` forwarding;
  dashboard popouts have independent routing. Guest DevTools emits `input-event`.
- `agent-input-injection.ts` excludes agent-injected input from Orca shortcuts.
- Desktop settings use `GlobalSettings`, default settings, loaded/update
  normalization, the local `settings:set` IPC acknowledgement, and the existing
  renderer settings store. Host RPC settings projections are explicit allowlists.
  This preference belongs to the desktop view owner and must stay outside those
  RPC projections, so an older execution host never receives an unknown field.

## Activity semantics

Reuse accepted status records and existing status projections; do not inspect
paths, shell existence, unread state or session history to infer work.

The terminal status vocabulary is `working`, `waiting`, `blocked`, `done`.
Native-chat status projects into the same vocabulary through
`structuredAgentSessionAgentStatus`. Its main-agent working predicate includes a
running turn or an unanswered send; running tools and compaction remain part of
that live work. `foldAgentLeadStatus` includes child work after the main turn ends,
but a waiting child can mask a working main agent in the combined display state.
The implementation therefore considers main-agent and child facts together,
not just the display row's `state === 'working'`.

`isLiveChildWork` retires children only on `done` or `idle`; absent/unknown state and
lost contact do not prove exit. Waiting children ask for human input; non-agent
shell/watch-only work projects as `monitoring`. Published owned commands and
monitoring work qualify because existing lifecycle semantics still consider them
live work. Waiting-only rows do not qualify. Settled child membership, `done` and
`idle` do not qualify. A waiting display row still qualifies if its main agent or
another child works. Unverifiable live child work keeps the existing conservative
lifetime rule.

Local and SSH hook facts already feed the main-process awake service. Paired
remote/native chat facts also live in the renderer's existing accepted
`agentStatusByPaneKey` projection. That map has existing freshness epochs, mirrored
receipt clocks, restored-unconfirmed handling and live structured-feed ownership.
The desktop activity mirror carries only a derived boolean from that existing
projection over local IPC, with sender validation and renderer-lifetime cleanup.
Launch/title-only seeds and restored-unconfirmed rows do not qualify. Local
runtime work also uses the awake service's existing working count. There is no
second runtime or activity polling service.
That additive main-process count requires `observedInCurrentRuntime`, `working`
and the existing finite `receivedAt` lease of two hours. The renderer projection
uses its existing 30-minute freshness rule and structured-feed ownership.
The existing freshness scheduler bumps `agentStatusEpoch` at the stale boundary,
including mirrored terminal rows; the activity subscription republishes then.
Unavailable remote contact must never manufacture a remote process exit.

## Gesture contract

An enabled busy chord starts only on a fresh, unmodified Cmd+Q keydown. Repeats do
not restart or accelerate the deadline. Release of Q or Command, blur, destruction
of the window/WebContents, or disabling the setting cancels the gesture and timer.
One completed continuous hold invokes the existing user Quit route exactly once.
Finishing work after a canceled tap never schedules a later quit; a fresh idle tap
quits. Finishing work while the genuine chord remains pressed may still allow its
existing deadline to complete.

Release cancels progress and the quit timer independently of the briefly
lingering explanation. Finishing work or disabling the setting dismisses a stale
busy hint. The hint exposes accessible status text and never takes focus.

Every actual focused desktop surface must observe the same gesture, including
terminal/editor inputs, embedded guests and supported popouts. Recording a shortcut
must retain ownership. No Q may leak into terminal/editor input. Hint presentation
must not activate, reveal or focus any window.

## Input feasibility finding

Preventing the first `before-input-event` keydown is unsafe when relying only on
JavaScript release events for a continuous hold.
Exact Electron 43.8.1 returns `HANDLED` from `PreHandleKeyboardEvent` after
`preventDefault()`. Matching Chromium 150.0.7871.250 then suppresses subsequent
keyup events before Electron can observe them. Orca's existing hold-dictation
implementation documents the same boundary.

A hidden Electron probe confirms the suppression with `sendInputEvent`: prevented
Cmd+Q yields neither Q-up nor Meta-up; allowing the keydown preserves both injected
releases. CDP's `Input.dispatchKeyEvent` bypasses `before-input-event` and therefore
cannot alone validate that boundary.

There is a second native boundary even when the keydown is allowed. Electron's
`AtomApplication` subclasses `NSApplication` and delegates `sendEvent:` directly
to `super`. Chrome 150 has an explicit workaround forwarding Command-modified
keyup to its key window, because the base `NSApplication` swallows those events.
Electron does not inherit Chrome's `BrowserCrApplication` implementation. Thus a
physical Q release while Command remains held is not proven observable by the
supported Electron JavaScript input API. A timer based on injected releases alone
could quit after a short physical Q tap.

Removing only the native Quit accelerator while opted in avoids the native menu
bypass and Chromium's handled-keydown suppression, but does not repair the
NSApplication release gap. Electron's `registerAccelerator: false` display-only
option is documented for Linux/Windows, not macOS; no guessed flag should be used.

Primary source evidence:

- [Electron 43.8.1 keyboard prehandling](https://github.com/electron/electron/blob/v43.8.1/shell/browser/api/electron_api_web_contents.cc#L1677)
- [Chromium 150 handled-keydown suppression](https://github.com/chromium/chromium/blob/150.0.7871.250/content/browser/renderer_host/render_widget_host_impl.cc#L1734)
- [Electron application superclass](https://github.com/electron/electron/blob/v43.8.1/shell/browser/mac/electron_application.h#L14)
- [Electron native event dispatch](https://github.com/electron/electron/blob/v43.8.1/shell/browser/mac/electron_application.mm#L111)
- [Chrome's Command-keyup workaround](https://github.com/chromium/chromium/blob/150.0.7871.250/chrome/browser/chrome_browser_application_mac.mm#L367)

The user-supplied Vorssaint reference confirms the intended hold/cancellation/hint
interaction, but operates via native global monitoring for arbitrary apps. Its
implementation and branded visuals are not copied.

## Approved native resolution

The coordinator approved extending the existing packaged `orca-keyboard-layout`
helper with a separate `--watch-quit-chord` mode. Default layout behavior and the
existing macOS 11 universal build/signing/package path remain unchanged. No new
binary, dependency, event tap, permission request or global input listener is added.

The helper runs only during an enabled busy quit gesture. After verifying the
accepted physical key and Command are held, it starts its own full 1000 ms interval
and checks state and release/modifier counters about every 8 ms. Changed counters
cancel release-and-repress even between samples; uncertain results fail closed.
This adds helper startup latency to the hold (about 75 ms in warm disposable
measurements). Progress starts on its `watching` acknowledgement; the work
explanation appears immediately on the original keydown.

An initial experiment found Node hrtime and Swift DispatchTime had different
epochs. A later `mach_continuous_time` probe matched Node in all five bracket
checks, but the coordinator chose a native-owned interval. Production bridges no
clocks and depends on no experimental offset.

Fresh nonrepeat presses replace the gesture generation. Repeats do nothing.
Cancellation stops the helper and invalidates its output; only the current focused
enabled gesture can consume `held`. Missing/old/erroring helpers show
**Hold-to-quit is unavailable. Use the application menu to quit.** and never quit
asynchronously. Main consumes the guarded keydown before terminal/editor/guest
DOM input; native sampling independently observes release even when Chromium
suppresses JavaScript keyup. Guest DevTools reuses its existing raw `input-event`
parser and routes the hint to its owning app renderer. The enabled macOS menu shows a shortcut hint
without registering a native accelerator while an actual focused routable surface exists.
With no focused desktop/popup/DevTools route, native Cmd+Q returns, including when
all windows are hidden, minimized or unfocused and under the existing serve callback
policy. Menu refresh follows window focus/blur/show/hide/minimize/restore/closure,
BrowserWindow creation, popup registry registration/removal, contents destruction,
load and DevTools focus/ownership changes. The menu and keyboard guard share the
same WebContents ownership and focus predicates; unowned background pages and
orphan DevTools do not stand in for a focused input route.
Explicit menu clicks keep the existing Quit route; custom shortcut bindings and
recording retain ownership.

Native browser popups extend the existing main-owned popup registry with their
actual BaseWindow/BrowserWindow and trusted notice presenter. The existing
BaseWindow origin bar expands over the page without changing its viewport; a
native BrowserWindow creates a small isolated notice view only during the hint.
Both preserve committed-origin identification, keep notices outside the OAuth
page DOM, accept no page activity IPC, and clean up on cancel/dismiss/destruction.
The ordinary UI/embedded guest/dashboard/space/DevTools route stays the same.

The disposable native probe read release counters with both Input Monitoring and
Accessibility preflight false and requested no permission. Positive physical
held-key behavior remains unvalidated; no focused desktop experiment or OS input
synthesis has run.

## Validation

Validation includes meaningful red/green tests for
settings defaults/persistence/acknowledgement, local and remote activity
projection, menu bypass, shortcut ownership, 999/1000 ms boundaries, every release
and lifecycle cancellation, repeats, once-only quit, and untouched explicit Quit
and update/serve routes. Hidden rendered English settings and hint evidence must
be separate from native physical keyboard validation. The latter has not run.

The focused suites, four-project Bun CI typecheck, changed-code quality,
localization coverage, formatting and normal commit hooks passed. Hidden Electron
43.8.1 screenshots verify the actual English setting and all hint phases without
showing or focusing a window. A rebuilt source input fixture verifies consumed Q
and an absent native menu accelerator with simulated routing focus; it proves no
physical key-release behavior.

The full related-test aggregate was gracefully interrupted at the coordinator's
request because it overlaps final combined integration validation. Its partial
log is incomplete, not green and not a timeout/stall verdict. The initial format,
menu-size and localization findings were fixed and their checks passed separately.
The helper preserves layout output and builds universally with command-local
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`: x86_64 and arm64 slices
pass strict local ad-hoc signature verification. Initial CommandLineTools-only
linking failed identically on the upstream baseline because its Swift compatibility
archives lack x86_64; full Xcode resolves that environment issue. Deployment target,
build flags and global developer selection are unchanged. Production Developer ID,
notarization, packaged TCC and positive physical held-key validation have not run.
