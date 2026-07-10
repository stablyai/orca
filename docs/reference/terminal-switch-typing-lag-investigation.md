# Terminal Switch Typing Lag Investigation

Date: 2026-07-01

## Scope

This note tracks the investigation into terminal input lag that appears after switching workspaces or terminals in a heavy packaged Orca profile.

The user-visible symptom is that typing after switching back to a workspace can feel delayed for about one second. Text may appear all at once after the delay. The issue reproduced in the user's main packaged Orca app, but not reliably in lighter dev profiles.

## Current Reproduction Setup

- Main packaged Orca app is used for the meaningful repro.
- The main profile had roughly 150 terminals when the lag reproduced.
- The current worktree under test is `/Users/jinwoohong/orca/workspaces/orca/osprey`.
- The main app did not expose CDP, so browser-level renderer profiling was limited.
- The harness creates a throwaway bash terminal, switches away and back, sends a marker command, waits for a receipt file, and closes the throwaway terminal.
- Harness path: `.tmp/terminal-main-app-typing-lag/probe.mjs`
- The strongest repro switches through an old, output-rich workspace before typing in the probe terminal.
- Current deterministic alternate terminal:
  `term_4d7a0b50-e9ae-420e-ac5d-7ec12cbfa408` in the `triage-issues` workspace.

Useful harness modes:

```sh
ORCA_PROBE_RUNS=8 ORCA_PROBE_FOCUS_EACH_RUN=0 ORCA_PROBE_TYPE_MODE=terminal-send ORCA_PROBE_RECEIPT_MODE=file node .tmp/terminal-main-app-typing-lag/probe.mjs
ORCA_PROBE_RUNS=8 ORCA_PROBE_FOCUS_EACH_RUN=0 ORCA_PROBE_TYPE_MODE=daemon-direct-request ORCA_PROBE_RECEIPT_MODE=file node .tmp/terminal-main-app-typing-lag/probe.mjs
ORCA_PROBE_RUNS=8 ORCA_PROBE_SKIP_SWITCH=1 ORCA_PROBE_FOCUS_EACH_RUN=0 ORCA_PROBE_TYPE_MODE=daemon-direct-request ORCA_PROBE_RECEIPT_MODE=file node .tmp/terminal-main-app-typing-lag/probe.mjs
ORCA_PROBE_RUNS=4 ORCA_PROBE_FOCUS_EACH_RUN=0 ORCA_PROBE_SKIP_FOCUS=1 ORCA_PROBE_SAMPLE_RENDERER=0 ORCA_PROBE_ALT_TERMINAL=term_4d7a0b50-e9ae-420e-ac5d-7ec12cbfa408 ORCA_PROBE_TYPE_MODE=daemon-direct-request ORCA_PROBE_RECEIPT_MODE=file node .tmp/terminal-main-app-typing-lag/probe.mjs
```

## Key Measurements

### 2026-07-01 follow-up: cold visit vs warm revisit

After the metadata-only `listSessions()` fix, the user reported a sharper
pattern:

- First visit to a terminal, where the terminal briefly shows blank while the
  renderer/webgl surface loads, does not show the typing lag.
- Revisiting that same already-mounted terminal brings the lag back.

Code-level reproduction:

- `connectPanePty` previously armed a one-shot input liveness check from
  `noteVisibilityResume()`.
- The first `xterm.onData` input after a warm visibility resume called
  `window.api.pty.listSessions()` before forwarding the byte with
  `transport.sendInput(data)`.
- A focused unit regression captured the bad order as
  `["listSessions", "sendInput"]`.

Fix direction:

- Terminal input no longer starts a renderer→main→daemon session enumeration.
- Hidden→visible lifecycle reconciliation and daemon missing-session exit events
  remain responsible for stale pane cleanup.
- The focused regression now asserts that repeated warm resumes plus typing
  produce zero `listSessions()` calls from the input handler.

### 2026-07-01 follow-up: preserved old daemon after input fix

After the input-handler fix, the main packaged profile still reproduced the
warm-switch lag because the live v18 daemon was preserved from an older build:

- Fresh main-profile repro:
  `.tmp/terminal-main-app-typing-lag/result-2026-07-01T09-59-08-111Z.json`
- Direct daemon writes after switching took 661, 982, 998, 980, and 1000 ms.
- Receipt latency after the daemon write returned stayed low at 77-85 ms.
- No-switch control:
  `.tmp/terminal-main-app-typing-lag/result-2026-07-01T09-59-28-346Z.json`
  ended with fast direct daemon writes once the probe terminal settled.

The remaining source hot path was the visibility-resume dead-session sweep:

1. Switching a warm terminal hidden→visible ran the lifecycle visibility effect.
2. The effect scheduled `reconcileDeadSessions`.
3. `reconcileDeadSessions` invoked `window.api.pty.listSessions()`.
4. A preserved old daemon still implemented `listSessions` by snapshotting every
   live session, so the user's next daemon `write` queued behind that work.

Fix:

- Replace the automatic visibility-resume `listSessions()` sweep with a targeted
  single-session liveness check.
- Main exposes `pty:hasPty(id)`, which reads provider-owned in-memory PTY state
  and returns `null` when the provider cannot answer authoritatively.
- Renderer visible-resume asks only about each mounted pane's current PTY id.
  The pane tears down only on an authoritative `false`; `true`, `null`, rejected
  checks, remote-runtime ids, SSH ids, and stale/newborn races all fail open.
- Keep visibility resume process tracking and PTY-size reassertion intact.
- This preserves the recovery added by `a9ef6f916` for panes that missed
  `pty:exit` while hidden, without putting a daemon-wide session enumeration on
  the warm-switch/input path.

Verification:

- Focused vitest suite: `508` tests passed across terminal lifecycle,
  pty-connection, dead-session reconcile, and PTY IPC.
- Headful fullscreen E2E harness:
  `tests/e2e/terminal-warm-switch-no-list-sessions.tmp.spec.ts`
  wraps main-process `pty:listSessions` with an 800 ms stall and then switches
  warm workspaces and types into the terminal.
- Latest E2E artifact:
  `.tmp/terminal-warm-switch-no-list-sessions/result-1782929853828.json`
  showed `fullscreen: true`, `listSessionCallCount: 0`, and
  `postTypeEchoLatencyMs: 10`.

### CLI `terminal-send`, switch away/back

Result file: `.tmp/terminal-main-app-typing-lag/result-2026-07-01T06-59-45-098Z.json`

- Average echo latency was about 1841 ms.
- Receipt latency was roughly 836-1445 ms.

### CLI `terminal-send`, no switch

- Average echo latency was about 312 ms.

### CLI `terminal-send`, switch away/back, 1000 ms settle before send

- Average echo latency was about 574 ms.
- Receipt latency was mostly 1-227 ms, with one run around 684 ms.
- This suggests the problematic window is bounded and concentrated immediately after switch/resume.

### Direct daemon request, switch away/back

Result file: `.tmp/terminal-main-app-typing-lag/result-2026-07-01T07-04-43-497Z.json`

- The harness opened its own daemon control socket and sent the real daemon `write` request directly.
- Daemon write response time was roughly 947-1142 ms.
- Receipt latency after the daemon write response was about 76 ms.
- Average echo latency was about 1385 ms.

### Direct daemon request, no switch

Result file: `.tmp/terminal-main-app-typing-lag/result-2026-07-01T07-05-12-496Z.json`

- Daemon write response time was 0-45 ms.
- Receipt latency was roughly 76-85 ms.
- Average echo latency was about 258 ms.

### Direct daemon request, output-rich workspace switch

Result file: `.tmp/terminal-main-app-typing-lag/result-2026-07-01T07-22-06-789Z.json`

- The alternate terminal was `term_4d7a0b50-e9ae-420e-ac5d-7ec12cbfa408` in the `triage-issues` workspace.
- All four runs delayed.
- Direct daemon `write` response times were 1566, 1527, 1477, and 1333 ms.
- Average echo latency was about 1790 ms.
- A daemon CPU sample was captured at `.tmp/terminal-main-app-typing-lag/daemon-71111-sample-20260701032206.txt`.

Latest reproduced run:
`.tmp/terminal-main-app-typing-lag/result-2026-07-01T07-27-25-513Z.json`

- Two runs after switching through `triage-issues`.
- Direct daemon `write` response times were 1556 and 1582 ms.
- Receipt latency after the daemon write response was about 76-77 ms.
- This confirms the daemon request itself waits; once it returns, the PTY and shell process the input quickly.

### Direct daemon ping loop during switch

A direct daemon client sent `ping` requests every roughly 50 ms while the harness issued `orca terminal switch` away and back.

- Pings before and after the switch were effectively immediate.
- One ping sent around 469 ms after switch start waited 1212 ms.
- No terminal input was involved in this probe.

This is the strongest evidence so far that workspace/terminal switching creates a daemon event-loop stall. The typing lag is a user-visible symptom of the same stall, not the root trigger.

### Direct daemon request, no switch

Latest no-switch result:
`.tmp/terminal-main-app-typing-lag/result-2026-07-01T07-27-58-622Z.json`

- First run had a direct daemon `write` response of 571 ms, likely a new-probe/settling artifact.
- Next two runs were 0-1 ms.
- No-switch is generally fast once the probe terminal is settled.

### Pause after switching away

- Adding `ORCA_PROBE_AFTER_SWITCH_AWAY_MS=1500` before switching back made direct daemon writes fast again.
- This indicates expensive work starts when Orca switches into or resumes the output-rich workspace, then spills into the immediate switch-back/write window.

Latest pause-control result:
`.tmp/terminal-main-app-typing-lag/result-2026-07-01T07-29-58-568Z.json`

- Direct daemon `write` response times were 0, 0, and 0 ms.
- Echo latency was about 343-363 ms.
- This bounds the problematic window to roughly the first 1-1.5 seconds after switching into/through the expensive workspace.

### Synthetic heavy terminals

- Synthetic split panes with large scrollback were not enough to reproduce reliably.
- A plain heavy scrollback split reproduced once in four runs, then larger synthetic scrollback stayed fast.
- A synthetic TUI repaint split stayed fast.
- The issue is therefore not simply "large output" or "any hidden repaint"; old retained/reattach/snapshot state is still suspect.

### Output timestamp check

- `lastOutputAt` did not advance when switching through the `triage-issues` terminal and away.
- That weakens the theory that a resume-triggered SIGWINCH caused the child TUI to emit a fresh repaint burst.
- The delay can happen without fresh PTY output from the child process.

### Snapshot and resize controls

Direct `getSnapshot` probes on real sessions were much cheaper than the observed lag:

- Output-rich `triage` terminal: about 10 ms, roughly 122 KB response.
- Active `osprey` Codex terminal: about 57 ms, roughly 804 KB response.

Synthetic resize pulses on throwaway heavy-scrollback terminals were also cheap:

- Background 80x24 resize pulse: about 2 ms.
- Focused 232x86 resize pulse: about 2 ms.

These controls weaken the idea that one ordinary snapshot or one ordinary resize explains a 1.2-1.6 second stall. The remaining suspicious shape is switch-time fanout: many warm reattachments, snapshots, visibility/resume requests, pending-output drains, or checkpoint-like work running serially in the daemon.

### Daemon `listSessions` proof

The daemon-only measurement identified the blocking request:

```json
[
  { "type": "ping", "elapsedMs": 0 },
  { "type": "listSessions", "elapsedMs": 552, "count": 137 },
  { "type": "ping", "elapsedMs": 0 },
  { "type": "listSessions", "elapsedMs": 547, "count": 137 },
  { "type": "ping", "elapsedMs": 0 }
]
```

A second daemon-only queue test sent two `listSessions` requests and then a `ping` from another client:

```json
{
  "totalMs": 1069,
  "listSessions1Ms": 1068,
  "listSessions2Ms": 1068,
  "pingBehindListSessionsMs": 1034,
  "sessions": 137
}
```

This reproduces the same stall shape without terminal input or UI switching: a control request sent behind resume-time `listSessions` waits about one second.

Source cause:

- `TerminalHost.listSessions()` loops every live daemon session.
- For each session, it calls `session.getSnapshot()` only to read `cols` and `rows`.
- `getSnapshot()` serializes the headless xterm buffer, so a liveness/session-list request scales with terminal scrollback/state across the whole profile.
- Renderer visibility resume calls `window.api.pty.listSessions()` for dead-session reconciliation. With about 137 live daemon sessions, one resume-time list was about 550 ms; two back-to-back resumes were about 1.0-1.1 seconds.

## What This Rules Out

- It is probably not keyboard focus. Direct daemon writes reproduce the delay.
- It is probably not only renderer paint. Direct daemon writes wait before the shell receives bytes.
- It is probably not bash or node-pty readiness. No-switch direct writes are fast, and receipt latency after a delayed daemon response is low.
- It is probably not queueing only on Orca's normal daemon client socket. The direct-daemon harness uses a separate socket and still sees the delay.
- It is not caused by typing itself. A ping loop with no write showed the daemon stall during switching.
- It is unlikely to be a single normal `getSnapshot` or `resize` call, because direct controls for those operations are much cheaper than the observed stall.
- The resume-time dead-pane recovery is still necessary; the hot path should
  use single-PTY liveness, not a global session list.

## Current Conclusion

Switching workspaces or terminals can create a short daemon/main busy window
when warm resume triggers global session enumeration. During that window, even a
direct terminal `write` request waits before the daemon services it. Once the
daemon services the write, the shell receives and processes the bytes quickly.

The confirmed root for the remaining warm-switch lag is the visibility-resume
dead-session reconciliation path calling global `listSessions()` in profiles
with many preserved daemon sessions. The original dead-session recovery is valid;
the expensive primitive was the problem.

## Leading Hypotheses

1. Confirmed: resume-time dead-session reconciliation called daemon
   `listSessions`, and older daemons synchronously snapshot every live session
   to return cols/rows.
2. Confirmed: avoiding global `listSessions()` on warm resume removes the
   request that queued ahead of first post-switch input.
3. Possible secondary contributor: switching to certain old or output-rich
   workspaces may also reattach existing daemon-backed PTYs. The daemon
   `createOrAttach` path synchronously calls `existing.getSnapshot()` before
   responding.
4. Possible secondary contributor: hidden-output recovery, pending-output
   draining, or another snapshot-like serialization path runs synchronously on
   resume and delays request handling.
5. Less likely: workspace or terminal resume triggers visible-terminal
   resize/SIGWINCH or TUI repaint output. The unchanged `lastOutputAt`
   observation currently makes this less likely than `listSessions`.

## Relevant Code Areas

- CLI terminal send: `src/cli/handlers/terminal.ts`
- Runtime terminal send/focus/write: `src/main/runtime/orca-runtime.ts`
- Runtime PTY data handling: `onPtyData`, `trackHeadlessTerminalData`, hidden-output serialization in `src/main/runtime/orca-runtime.ts`
- Daemon request routing: `src/main/daemon/daemon-server.ts`
- Daemon session write/resize/output handling: `src/main/daemon/session.ts`
- Daemon-side headless terminal state: `src/main/daemon/headless-emulator.ts`
- Daemon adapter: `src/main/daemon/daemon-pty-adapter.ts`
- Main IPC PTY controller: `src/main/ipc/pty.ts`
- Renderer terminal resume: `src/renderer/src/components/terminal-pane/terminal-visibility-resume.ts`
- Renderer PTY connection and resume size reassertion: `src/renderer/src/components/terminal-pane/pty-connection.ts`
- Renderer output scheduler: `src/renderer/src/lib/pane-manager/pane-terminal-output-scheduler.ts`
- Existing-session reattach snapshot: `TerminalHost.createOrAttach` in `src/main/daemon/terminal-host.ts`
- Session snapshot serialization: `TerminalSession.getSnapshot()` in `src/main/daemon/session.ts`
- Snapshot cost benchmark: `src/main/daemon/headless-emulator-snapshot-cost.bench.test.ts`

## Current Root-Cause Theory

The root cause is using global session enumeration as a per-pane liveness check:

1. Workspace switching makes a terminal pane visible again.
2. The renderer schedules dead-session reconciliation on hidden-to-visible resume.
3. The old reconcile path called `window.api.pty.listSessions()`, which reaches
   the daemon `listSessions` RPC.
4. Older preserved daemons implement `TerminalHost.listSessions()` by calling
   `session.getSnapshot()` for every live session.
5. With a heavy profile, those snapshot serializations block the daemon event
   loop for about 550 ms per list.
6. A switch away/back can put a `write` behind two resume-time lists, yielding
   about 1.0-1.6 seconds of delayed input.

This theory fits the current evidence:

- Direct daemon writes block, so the delay is below keyboard focus and normal CLI plumbing.
- Receipt handling after the daemon write response is fast, so the shell and PTY are not the bottleneck.
- No-switch writes are fast.
- Waiting after switching away lets the expensive resume work finish, so switching back and typing is fast.
- `lastOutputAt` does not advance, so the child process probably is not generating the expensive work.
- Synthetic fresh heavy output did not reproduce reliably, which points toward retained old session/state, request fanout, or workspace-specific resume behavior rather than simple line count.

The correct fix is two-layered:

1. Keep daemon `listSessions` metadata-only for builds where callers genuinely
   need the global session list.
2. Do not use `listSessions` for warm-resume dead-pane recovery. Use
   `pty:hasPty(id)` to ask about the pane's own PTY id, backed by provider
   in-memory state. Close only on authoritative `false`; fail open on `true`,
   `null`, unsupported providers, remote-runtime/SSH ids, and stale/newborn
   races.

## Investigation Constraints

- Do not kill or restart the user's main packaged Orca app or daemon without explicit approval.
- Use throwaway terminals for probes and close them afterward.
- Keep temp harnesses and screenshots out of commits unless explicitly requested.
- Reproduce in the real main-app flow when possible; lighter dev profiles may not show the problem.

## Verification Plan

1. Unit-test that `pty:hasPty(id)` does not call provider `listProcesses()`.
2. Unit-test that targeted liveness still closes a missing local PTY and fails
   open for live/unknown/stale cases.
3. Unit-test that terminal input and warm resume do not call `listSessions()`.
4. Re-run the headful fullscreen warm-switch E2E with `pty:listSessions`
   artificially delayed and assert the count stays zero.
5. Re-run the main-app direct-daemon switch/no-switch harness when validating
   against the user's heavy profile.
