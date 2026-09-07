# Session grid wheel routing

Orca routes each vertical wheel gesture to the grid or to one terminal surface. Routing depends on pointer position, the selected wheel mode, and real keyboard focus. Application output, buffer boundaries, and agent names never decide ownership.

## Ownership contract

The setting is **Wheel over terminals**, with **According to focus**, **Terminal**, and **Grid**. Focus is the default.

| Pointer at gesture start | Terminal | Grid | Focus |
| --- | --- | --- | --- |
| Focused terminal | Terminal | Grid | Terminal |
| Unfocused terminal | Terminal | Grid | Grid |
| Grid header or gap | Grid | Grid | Grid |

- Shift reverses the destination over a terminal. Outside terminals, the grid remains the destination.
- Reaching either history boundary stops terminal scrolling; it never transfers movement to the grid.
- Focus means the actual xterm input owns keyboard focus in its focused document. Card selection alone is insufficient. Hover, wheel input and received output do not acquire focus.
- Trackpad ownership lasts until the existing 150 ms inter-event gap. Cards sliding beneath a stationary pointer do not acquire an ongoing gesture. Physical pointer movement into another surface changes destination immediately.
- Mode, Shift and focus changes invalidate ownership immediately. Each discrete wheel notch reevaluates the destination while preserving the existing grid step coalescing.
- Remaining movement for a removed terminal is swallowed until a new gesture or explicit destination change. It is never delivered to the next card accidentally.

The card's focus ring follows real terminal focus. The selected card keeps its border treatment independently. Header controls keep their own keyboard focus.

## Implementation responsibilities

- `session-grid-wheel-routing.ts` is the sole ownership coordinator. It captures grid-owned events, delivers terminal-owned events, and prevents uncancelled native terminal scroll chaining in bubble.
- `use-session-grid-scroll.ts` controls row/page/free grid movement using the existing gesture reducer.
- `session-grid-terminal-focus.ts` uses the existing xterm input ownership predicate for both routing and the focus affordance.
- `terminal-wheel-replay.ts` delivers Shift wheels without Shift, preserving distance, direction, delta units, legacy wheel metadata and timing.
- `pane-terminal-mouse-wheel.ts` retains TUI report multiplication. Generated reports bypass ownership arbitration and must never be multiplied twice.

There is no per-preview overflow handler or custom grid handoff event. Standalone previews retain xterm's normal behavior.

**Do not cancel a terminal-owned wheel in capture before delivering it to xterm.** Its native viewport ignores already-cancelled events. Contain native overflow in bubble after delivery. A replay is a separate uncancelled event.

**Preserve replay metadata.** Chromium may regenerate `wheelDeltaY` with a different sign. xterm and Orca use the legacy axes and timestamp for scrolling and device classification. Horizontal Shift input maps both modern and legacy axes to vertical.

**Convert units only at the grid destination.** Pixel, line and page deltas are not interchangeable; terminal delivery retains its original units.

## Persistence and mixed versions

The renderer uses `focus | terminal | grid`. Disk and RPC retain `auto | terminal | grid`: `auto` is only the historical encoding of Focus for current clients. Hydration maps it to Focus; the existing persisted-UI write adapter maps Focus back to `auto`. Missing settings default to Focus; invalid settings preserve the current value.

The writer baseline holds normalized renderer values, preventing write/echo cycles. No new RPC fields, enum values, capabilities or terminal-stream messages are introduced. Older clients retain their historical interpretation of Auto. Grid and Terminal round-trip unchanged.

## Regression checks

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm run test:session-grid-scroll
```

Set `ORCA_SCROLL_BROWSER_CHANNEL=chrome` to use an installed Chrome instead of Playwright Chromium. The runner is headless, uses an isolated profile, and checks real xterm viewport movement, native wheel events, focus and emitted scroll-input bytes. Mouse-motion reports are distinct from wheel reports. It does not launch agents or validate Electron's native window focus.

Unit and React tests cover routing transitions, stationary versus moved pointers, disposal, focus affordances, grid snapping and preference compatibility. Keep real-browser assertions: a fake terminal that cancels every wheel previously hid native grid overflow and capture cancellation bugs.

`tests/e2e/session-grid-wheel-mode.spec.ts` checks the translated selector and mode selection in an isolated hidden Electron renderer, retaining a CDP screenshot. Native window-focus transitions still require CI or an isolated display.

Orca rendered-UI checks require the repository's Electron skill and Playwright CDP. Native-window focus validation belongs on CI or an isolated display; never reveal a test window on the user's desktop.

A separate audit finding remains outside this change: previews subscribe to xterm `onData`, while legacy mouse encoding can emit `onBinary`. That transport work requires end-to-end byte-preserving validation; modern SGR wheel routing does not establish support for legacy encoding.

## Research behind retiring Auto (2026-09-07)

Deterministic boundary handoff is feasible when xterm owns the history or the application cooperates. The ordinary mouse protocol and reviewed xterm APIs do not provide application-history boundaries or wheel-consumption acknowledgements. Application scrollbar extensions do exist (see the general-purpose alternatives below), but require application participation. ANSI screen output and mouse-mode flags alone are insufficient: identical visible screens can have different hidden history.

| Application | Concrete route | Evidence and limitations |
| --- | --- | --- |
| Codex | Inline history with `--no-alt-screen` | Installed CLI help explicitly describes preserving terminal scrollback. Validate routing against that renderer; do not infer ownership from the application name. |
| Claude Code | Classic renderer with `/tui default` or `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` | [Official fullscreen documentation](https://code.claude.com/docs/en/fullscreen) describes native scrollback. Background sessions opened through agent view or `claude attach` always use fullscreen, so this route does not cover them. Disabling mouse alone leaves fullscreen history inaccessible to the wheel. No documented scroll hook was found. |
| Grok | `--minimal`, which prints finalized blocks into native history | Verified in installed Grok 1.0.13 help; explicitly experimental and session-scoped. The running turn remains in a pinned region and needs separate validation. `--no-alt-screen` is also documented in [CLI flags](https://docs.x.ai/build/cli/headless-scripting), but inline rendering alone does not prove all history is terminal-owned. |
| OpenCode | A TUI adapter reporting actual scroll-widget state | [CLI plugin documentation](https://opencode.ai/v2/docs/build/plugins/cli/) exposes the renderer, and [OpenTUI ScrollBox](https://opentui.com/docs/components/scrollbox/) exposes scroll position and content dimensions. This is a promising integration path, not a tested adapter. The reviewed plugin docs target v2; installed OpenCode is 1.18.29, so compatibility and access to the session's actual scrollbox must be established first. |

These alternatives were researched before choosing Focus. No agent launch flags or configuration were changed.

### Application adapter alternative (not implemented)

Keep routing independent of agent names. A surface advertises either observable native history, a cooperating application adapter, or unknown application-owned history. Explicit Terminal/Grid modes and Shift retain priority over every adapter.

For cooperating applications, a cached `canScroll` flag alone can race with streaming output or resize. The stronger contract associates a wheel request with an application acknowledgement of consumption and an explicit boundary result. The application applies and evaluates the request against its real active scroll target; Orca uses that result with the existing gesture policy to decide handoff. Silence or a timeout must never count as a boundary. Avoid delivering the same wheel through both the adapter and ordinary mouse input.

Any implementation must follow `remote-wire-compatibility.md`: negotiate capabilities, scope requests to the terminal and connection generation, discard stale replies after reconnect or mode changes, and preserve unknown state when contact is lost. Test active dialogs, nested scroll targets, resize, streaming, rapid direction changes, Shift changes, and SSH latency before claiming deterministic behavior.

The first useful proof is access to the installed OpenCode session's real scrollbox and its post-wheel consumption result in an isolated fixture. If that requires patching private internals, document the version coupling rather than presenting it as a stable plugin API. Claude fullscreen still needs an application-provided integration; the research did not establish a supported one.

### General-purpose alternatives reviewed

This was source and protocol research, not validation against live agent sessions.

| Approach | What it actually observes | Outcome |
| --- | --- | --- |
| DOM `scrollTop`, `scrollHeight`, scroll chaining and CSS `overscroll-behavior` | Browser scroll containers | Useful for native terminal history and grid containment. An application's virtual transcript is not a nested DOM scroll container. CSS cannot expose it. See the [W3C specification](https://www.w3.org/TR/css-overscroll-1/). |
| `defaultPrevented`, `dispatchEvent()` return, or a custom wheel handler | Local event dispatch | Installed xterm `MouseService._handleWheel` sends input, then unconditionally prevents default and stops propagation. Its result does not acknowledge application movement. `attachCustomWheelEventHandler` is a pre-processing gate. |
| xterm `onScroll`, `onWriteParsed`, buffer inspection, DOM/canvas observation | Terminal viewport or received output | [The API](https://xtermjs.org/docs/api/terminal/classes/terminal/) exposes viewport changes and parsed output, not the application's hidden transcript position. A render callback does not associate output with a specific input. |
| Alternate-scroll mode or synthesized arrow/PageUp keys | A different input encoding | [XTerm wheel documentation](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Mouse-Tracking) describes translating wheel to cursor keys; it adds no boundary response. Arbitrary keys can also act on a different widget. |
| Synchronized output, DEC 2026 | Application-defined output batches | [The specification](https://contour-terminal.org/vt-extensions/synchronized-output/) controls presentation of updates. A completed frame does not confirm that a particular wheel was processed or that history is exhausted. |
| Mintty application scrollbar | Application-published position, document size and viewport height | A concrete generic extension exists: `CSI pos;size;height # t`. [Mintty documents it as experimental](https://github.com/mintty/mintty/wiki/CtrlSeqs#application-scrollbar). Orca could implement one parser for it, avoiding agent-name routing, but each application must emit it. No support was established for the user's agents; terminal-side support alone is insufficient. |
| Force alternate-screen output into a scrollback buffer, or retain screen snapshots | Previously received terminal output | Changing buffer storage does not make a TUI send its unrendered transcript. Cursor-addressed redraws can overwrite content; snapshots are a screen recording, not a complete conversation history. |
| Compare text movement across frames, ignoring animation | An estimate of visual displacement | Can be implemented once in JavaScript, but remains heuristic. Repeated text, asynchronous redraws, output arriving during input, and absent frames produce ambiguous observations. Increasing a timeout does not remove that ambiguity. |

A general-purpose deterministic interaction can instead choose ownership by pointer region, explicit activation, or a modifier, keeping each gesture with its chosen owner. This changes the Auto interaction contract; it is not boundary detection and must not be substituted without a product decision. The Focus interaction above was subsequently chosen; no agent integration is needed.
