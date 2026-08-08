# Terminal Scroll Intent Architecture

## Problem

Terminal panes can jump or jitter when a user switches workspaces while a TUI
pane is scrolled near, but not exactly at, the bottom. The most visible case is a
Codex-style alternate-screen TUI in a split pane:

1. The user scrolls slightly up from the bottom.
2. The user switches to another workspace.
3. The user switches back.
4. The terminal sometimes jumps to the top, jumps to the bottom, flashes at a
   wrong position, or restores an older viewport.

The current code tries to repair the viewport after layout, fit, split
reparenting, hidden-output replay, and visibility resume. Those repairs compete
with each other because none of them owns the user's scroll intent. A delayed
restore can replay an old state after the user has already scrolled, while a
follow-output path can force the bottom even when the user is reading scrollback.

## Reference Investigation Summary

The useful reference pattern is not a timer-based restore loop. It is an
explicit pinned-to-bottom model owned by the terminal frontend:

- The frontend stores bottom-following state separately from xterm's transient
  `viewportY`.
- `xterm.onScroll` is not used as user intent. In xterm, that event can be
  content-driven and can briefly report bottom during fast output or layout work.
- User wheel and keyboard scroll commands update the intent.
- `scrollToBottom()` is an explicit command that sets the intent back to
  follow-output.
- Every write snapshots the intent before writing. If the terminal was following
  output, it scrolls to bottom after the write. If the user was pinned to a
  viewport, it preserves the prior viewport line.
- Fit/resize uses the same rule: follow bottom if explicitly pinned, otherwise
  preserve the current viewport.
- Alternate-screen state is tracked from `buffer.active.type`, but it is not a
  reason to infer user scroll intent from `onScroll`.

The reference implementation also patches private xterm internals to disable
xterm's implicit scroll-to-bottom behavior and call the original bottom-scroll
only from explicit owner paths. That gives a clean ownership boundary, but it is
an escalation point for Orca because private internals increase xterm upgrade
risk.

## Current Orca Risk Points

The current Orca branch already has several independent scroll actors:

- `src/renderer/src/lib/pane-manager/pane-scroll.ts` captures `viewportY`,
  `baseY`, bottom state, and sometimes a marker, then restores using immediate,
  rAF, and timeout paths.
- `src/renderer/src/lib/pane-manager/pane-tree-ops.ts` captures and restores
  scroll around `safeFit()`.
- `src/renderer/src/lib/pane-manager/pane-split-scroll.ts` schedules split
  reparent restores across rAF and timeout phases.
- `src/renderer/src/components/terminal-pane/use-terminal-scroll-visibility-memory.ts`
  listens to `terminal.onScroll` and stores snapshots while visible.
- `src/renderer/src/components/terminal-pane/pty-connection.ts` writes PTY output
  through foreground, background, hidden-output skip, snapshot replay, and
  restore paths.
- `src/renderer/src/lib/pane-manager/pane-terminal-output-scheduler.ts` can
  write immediately, enqueue foreground writes, coalesce synchronized output, or
  drain hidden/background chunks later.

The biggest architectural mismatch is the visibility memory hook's use of
`terminal.onScroll` as a snapshot trigger. That event is not a reliable user
scroll signal. During workspace switching, output parsing, hidden replay, or fit
can make it persist transient positions that later appear as "older position"
restores.

## Design Goal

Make terminal viewport movement a result of explicit scroll intent, not a side
effect of visibility, output, or layout timing.

The terminal should have one active scroll intent per pane:

- `followOutput`: the terminal is logically pinned to the live output bottom.
  New output, explicit focus-follow requests, and fits may keep it at bottom.
- `pinnedViewport`: the user is reading a specific viewport. New output,
  workspace switches, hidden-output replay, and fits must not move the viewport
  except when scrollback pruning or buffer replacement makes the exact line
  impossible.

## State Model

Add a focused module, for example:

`src/renderer/src/lib/pane-manager/terminal-scroll-intent.ts`

Suggested state:

```ts
export type TerminalScrollIntentKind = 'followOutput' | 'pinnedViewport'

export type TerminalScrollIntent = {
  kind: TerminalScrollIntentKind
  bufferType: 'normal' | 'alternate'
  viewportY: number
  baseY: number
  capturedAt: number
}
```

The state should be keyed by the live `Terminal` or by pane leaf identity where
it needs to survive pane replacement. For normal workspace switches that keep
the same xterm instance, the live terminal-keyed state should be authoritative.

## Intent Transitions

Only these events should change scroll intent:

- User wheel scrolls upward: set `pinnedViewport` immediately before xterm write
  callbacks or rAF can pull the viewport back down.
- User wheel scrolls downward: after xterm applies the scroll, recompute whether
  the viewport reached bottom. If yes, set `followOutput`; otherwise keep
  `pinnedViewport`.
- User keyboard scroll commands: apply the same rules as wheel.
- Explicit `scrollToBottom()`, "follow output", or focus command with
  follow-output semantics: set `followOutput`.
- Programmatic `scrollToTop()` or page/line scroll commands: set
  `pinnedViewport`, unless the resulting viewport is bottom.
- Buffer change to alternate screen: record `bufferType`, but do not infer
  follow-output from `onScroll`.
- Buffer return to normal screen: recompute from current viewport only if no
  stronger user intent exists for the normal buffer.
- Scrollback prune: clamp a pinned viewport to the nearest valid line without
  changing intent.
- Terminal remount/replay: restore from durable fallback only if the live xterm
  instance was actually replaced.

Do not use xterm `onScroll` to set intent. It may still be useful as a passive
diagnostic signal, but it should not persist authoritative scroll state.

## Write Contract

All PTY output that reaches xterm should pass through one wrapper that enforces
intent around the actual `terminal.write` call.

Suggested owner:

`src/renderer/src/lib/pane-manager/pane-terminal-output-scheduler.ts`

Contract:

1. Capture intent and current `viewportY` before the write is scheduled.
2. Execute the write through the existing foreground/background/coalescing path.
3. After the write has parsed enough for xterm buffer state to be meaningful:
   - If intent is `followOutput`, scroll to bottom.
   - If intent is `pinnedViewport`, clamp and restore the saved viewport line.
4. Do not schedule multi-frame retries for normal output. A single post-write
   enforcement point should be enough for standard writes.

For foreground synchronized-output holds, the enforcement point should run after
the held/coalesced frame is released, not for each partial cursor-hide chunk.

For background writes, preserve `pinnedViewport` if the pane is hidden or
inactive. Hidden output should not silently repin the terminal.

## Fit And Resize Contract

`safeFit()` should stop using generic delayed scroll restoration as its normal
behavior.

New rule:

1. If dimensions do not change, do nothing.
2. Before fit, capture current intent and viewport.
3. Fit.
4. If intent is `followOutput`, scroll to bottom.
5. If intent is `pinnedViewport`, restore the saved viewport line clamped to the
   new `baseY`.

Avoid fitting hidden or zero-geometry panes. Existing geometry guards should
remain because fitting to transient workspace-switch geometry can send bad sizes
to the PTY and trigger TUI redraw churn.

## Visibility And Workspace Switch Contract

Workspace switching should not be a scroll operation.

On hide:

- Capture the current intent once.
- Do not run scroll restore.
- Do not update intent from `onScroll`.
- Continue hidden-output throttling/snapshot behavior as today.

On show:

- Reattach or refresh renderer resources as needed.
- Flush only the bounded amount of hidden output required for the active pane.
- Apply intent once after the visible output catch-up:
  - `followOutput` goes to bottom.
  - `pinnedViewport` stays pinned.
- Do not run repeated rAF/timeout scroll restores.

If the underlying terminal instance was replaced, use durable fallback state.
If the instance stayed alive, its live scroll intent is authoritative.

## Hidden Output And Snapshot Replay

Hidden-output snapshot replay is a true fallback path because it clears and
reconstructs xterm content. It needs scroll handling, but it should still obey
intent:

- Before snapshot replay, capture intent and viewport.
- Replay serialized content.
- Fit only if needed and only with valid visible geometry.
- Reapply the captured intent once:
  - `followOutput`: bottom.
  - `pinnedViewport`: previous viewport line, clamped.
- Do not let replay set follow-output just because the replayed buffer ends at
  bottom.

If hidden output arrives while the user is pinned, background catch-up should not
move the visible viewport on activation.

## Split Reparenting

DOM reparenting can reset browser scroll state and WebGL resources. This is a
legitimate place for a fallback restore, but it should be scoped:

- Capture intent before reparent.
- Reparent.
- Reattach renderer if required.
- Apply intent once after DOM settles.
- Avoid restoring alternate-screen scrollback, because alternate screen has no
  normal scrollback and a TUI owns its cursor.

The current split-specific rAF/timer code should become a local fallback for DOM
reparenting only, not a general model copied into workspace switching.

## Performance Constraints

The design must preserve Orca's terminal performance priorities:

- Do not keep all hidden terminals hot-rendering.
- Keep PTY/session/xterm state warm when feasible, but suspend hidden rendering
  work and throttle hidden output as today.
- Avoid per-output layout reads. Intent enforcement should read xterm buffer
  fields, not DOM geometry.
- Avoid multi-frame restore loops. They cause visible jitter and keep the
  renderer busy after activation.
- Keep active-pane hidden-output catch-up bounded. Inactive visible split panes
  can catch up over later frames.
- Do not send resize/SIGWINCH unless dimensions actually changed and the
  renderer is the authoritative size owner.

The intended steady-state cost is one small buffer-state capture per xterm write
batch, not per byte and not per animation frame.

## Implementation Plan

1. Add `terminal-scroll-intent.ts`.
   - Track `followOutput` vs `pinnedViewport`.
   - Provide helpers for user scroll, explicit bottom, write capture, fit
     capture, and intent enforcement.

2. Replace visibility-memory `onScroll` ownership.
   - Remove authoritative snapshot updates from `terminal.onScroll`.
   - Add capture-phase wheel listeners and keyboard scroll command hooks.
   - Keep `onScroll` only for diagnostics if needed.

3. Route explicit scroll commands through intent helpers.
   - `scrollToBottom()` sets `followOutput`.
   - `scrollToTop()`, page up, and line up set `pinnedViewport`.
   - Downward commands recompute after the command.

4. Wrap output writes.
   - Add an intent-aware writer boundary in the output scheduler or in a narrow
     wrapper used by the scheduler.
   - Ensure foreground coalescing applies intent after the coalesced frame.
   - Ensure background drains preserve pinned viewports.

5. Convert `safeFit()` to intent-aware fit.
   - Capture intent before fit.
   - Apply once after fit.
   - Remove generic deferred scroll restore from normal fit.

6. Limit restore fallbacks.
   - Keep fallback restore only for true remount/replay/reparent cases.
   - Remove workspace-switch rAF/timeout restore loops once intent enforcement is
     in place.

7. Add focused tests.
   - User scroll up sets `pinnedViewport`.
   - Output while pinned preserves viewport.
   - Output while following scrolls to bottom.
   - Fit while pinned preserves viewport.
   - Fit while following stays at bottom.
   - Hidden-output replay while pinned does not repin.
   - Workspace hide/show does not change intent.
   - `onScroll` does not mutate intent.

8. Add an E2E reproduction.
   - Use the existing `scroll-primary` and `scroll-secondary` worktrees.
   - Top pane in `scroll-primary` contains the TUI with enough scrollback.
   - Scroll slightly above bottom, switch to `scroll-secondary`, then switch back.
   - Assert the terminal remains within a small viewport tolerance and does not
     visit top/bottom during the transition.

## Acceptance Criteria

- Switching away and back does not move a pinned TUI viewport.
- No visible flash to top or bottom during activation.
- Scrolling all the way to bottom re-enables follow-output and does not later
  restore an older pinned position.
- Hidden output in inactive workspaces does not change visible scroll position
  until the user explicitly follows output or reaches bottom.
- Alternate-screen TUIs do not receive extra restore/fill behavior that shifts
  their cursor or scroll region.
- The active pane remains responsive during heavy hidden-output catch-up.

## Open Decisions

- Whether Orca should patch private xterm bottom-scroll internals. The reference
  pattern does this for strict ownership, but Orca should first try public API
  enforcement at write/fit boundaries and only escalate if xterm continues to
  auto-follow independently.
- Whether scroll intent should be stored only by live `Terminal` instance or also
  mirrored by leaf ID for remount fallback. The initial implementation should
  use live instance state plus a leaf-keyed fallback for true replacement.
- Whether alternate screen needs a separate intent record from normal screen.
  The first version can use one record with `bufferType`; a separate normal vs
  alternate record is justified only if testing shows mode switches overwrite
  user intent.
