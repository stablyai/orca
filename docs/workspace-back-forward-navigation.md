# Design Document: Workspace Back / Forward Navigation

## 1. Overview

Orca users routinely juggle many worktrees. The sidebar and `Cmd+J`
jump palette make it cheap to *find* a worktree, but there is no cheap
way to *retrace your steps* — e.g., jump from "review worktree" → "bug
repro worktree" → and then back to "review worktree" without re-typing
the search query.

This design adds browser-style **Back** and **Forward** buttons to the
top-left titlebar, placed immediately after the active-agent badge, so
the user can move through their recent worktree-activation history with
one click (or a keyboard shortcut).

## 2. User Experience

### 2.1 Placement

Buttons live in `titlebarLeftControls` (rendered in
[`src/renderer/src/App.tsx`](../src/renderer/src/App.tsx)) in the
following order, left to right:

1. macOS traffic-light pad (or `pl-2` on non-Mac / fullscreen)
2. Sidebar-toggle button (`<PanelLeft />`)
3. Active-agent badge (the popover with the `N` working agents)
4. **Back button (`<ChevronLeft />`)** ← new
5. **Forward button (`<ChevronRight />`)** ← new

The Back/Forward pair renders **only when `activeView === 'terminal'`**.
In Settings, Tasks, and Landing views the pair is hidden (not disabled)
so the titlebar stays compact and the buttons' semantic meaning is
unambiguous: they navigate worktree-activation history, which is only
meaningful when a worktree is being viewed. The surrounding
`titlebarLeftControls` node (sidebar toggle, agent badge) still renders
in both the sidebar-width `titlebar-left` header and the full-width
`.titlebar`; the new buttons are simply conditional within it.

### 2.2 Button Behavior

- **Back**: activates the previous worktree in the history stack.
  Uses the native `disabled` attribute (CSS selector `:disabled`
  already handles greying — see `.sidebar-toggle:disabled` in
  `src/renderer/src/assets/main.css:339–346`); `aria-disabled`
  follows implicitly via the HTML `disabled` semantics. Disabled
  when there is no previous worktree.
- **Forward**: activates the next worktree. Disabled (same mechanism)
  when the user is already at the head of the stack.
- Clicking either button triggers the same `activateAndRevealWorktree`
  path used by the jump palette, so focus, tab restoration, sidebar
  reveal, and GitHub refresh-if-stale all run exactly as they do for
  any other navigation.
- If the target worktree no longer exists (deleted between visits),
  the entry is skipped and the next valid entry is tried. If none
  remains in that direction, the button becomes disabled.
- **History is recorded for every activation of a worktree**, which
  by definition routes to the terminal view (see
  `activateAndRevealWorktree` step 2, which unconditionally calls
  `setActiveView('terminal')`). Settings, Tasks, and Landing
  transitions are not worktree activations and do not touch the
  history stack; the buttons are hidden in those views (see §2.1).
  This keeps the stack to a single, unambiguous meaning:
  "worktrees you've been looking at."
- **Forward is truncated by any new sidebar / jump-palette
  activation.** This matches how every browser behaves: taking a new
  path while not at the head of history drops the forward entries.
  The visible affordance is the Forward button flipping from enabled
  to disabled with no intermediate state. We considered a transient
  toast the first time this happens but chose to match browser
  behavior exactly — the pattern is already deeply familiar.

### 2.3 Visual Design

Re-use the existing `.sidebar-toggle` button class (same 16px icon,
same hover treatment) so the new controls blend with the sibling
sidebar-toggle already in the titlebar. Icons: `ChevronLeft` and
`ChevronRight` from `lucide-react` at `size={16}`, matching the
`<PanelLeft />` used next to them.

Disabled state uses the existing `.sidebar-toggle:disabled` styling
(already defined in `main.css`), so no new CSS is required.

The buttons are keyboard-reachable (native `<button>`), expose the
tooltip text as `aria-label`, and inherit `:focus-visible` treatment
from `.sidebar-toggle`'s existing style rules.

On first launch (and on any app start, since history is session-scoped)
both buttons render visibly disabled until the user has activated at
least two worktrees. This is acceptable because (a) the tooltip
explains each button's purpose on hover, and (b) the same cold-start
affordance is what browsers and VS Code ship.

### 2.4 Tooltips

- Back: `"Go back (⌘⌥←)"` on Mac, `"Go back (Ctrl+Alt+←)"` elsewhere.
- Forward: `"Go forward (⌘⌥→)"` on Mac, `"Go forward (Ctrl+Alt+→)"` elsewhere.

Mirrors the sidebar-toggle tooltip pattern already present in `App.tsx`.
Platform detection reuses the module-level `isMac` constant already
defined in `App.tsx:44` (`const isMac = navigator.userAgent.includes('Mac')`).

### 2.5 Keyboard Shortcuts

- `Cmd+Alt+Left` (Mac) / `Ctrl+Alt+Left` (Windows, Linux) → Back
- `Cmd+Alt+Right` (Mac) / `Ctrl+Alt+Right` (Windows, Linux) → Forward

Why this chord:

- **Cross-platform symmetry.** One rule covers both platforms — Mac
  and Win/Linux differ only in meta vs. ctrl.
- **Collision-free against Orca's existing shortcut tables.** Verified
  against `terminal-shortcut-policy.ts`: the three Arrow-key rules
  each explicitly exclude the Meta/Ctrl+Alt+Arrow chord —
  (a) the isMac `Cmd+Arrow` rule (~line 134) gates on the
  top-of-function `mod` (Cmd without Ctrl on Mac, Ctrl without Cmd
  elsewhere) AND `!altKey`, so it never fires with Alt held;
  (b) the Alt+Arrow word-nav rule (~lines 163–177) requires
  `!metaKey && !ctrlKey && altKey && !shiftKey`, so it never fires
  when a primary modifier is held; (c) the `Ctrl+Arrow` word-nav
  rule off-Mac (~lines 179–197) requires
  `!isMac && !metaKey && ctrlKey && !altKey && !shiftKey`, so it
  never fires with Alt held. Also verified against
  `window-shortcut-policy.ts` (no Alt+Arrow or Meta+Alt chord) and
  `Terminal.tsx` / `useTerminalShortcuts.ts` (tab-switch requires
  `!alt`).
- **Discoverable direction.** Back = ←, Forward = →.
- **Works globally**, including when the xterm.js terminal or a
  browser guest has focus, because xterm.js does not intercept
  Cmd/Ctrl+Alt+Arrow.

Rejected alternatives:

- `Cmd+[` / `Cmd+]` (and `Cmd+Shift+[` / `Cmd+Shift+]` on
  Win/Linux): both chord variants are already bound. `Cmd+[` /
  `Cmd+]` on Mac and `Ctrl+[` / `Ctrl+]` on Win/Linux are
  "focus next/previous split pane"
  (`terminal-shortcut-policy.ts:61`); `Cmd+Shift+[` / `Cmd+Shift+]`
  on Mac and `Ctrl+Shift+[` / `Ctrl+Shift+]` on Win/Linux are
  "switch tab" (`Terminal.tsx:737`, `useTerminalShortcuts.ts:56`).
- VS Code's native chord (`Alt+Left/Right` on Win/Linux,
  `Ctrl+-` / `Ctrl+Shift+-` on Mac): VS Code routes the chord by
  focus — the shell gets `Alt+Arrow` for readline word-nav when the
  terminal is focused. In a terminal-centric product like Orca, a
  focus-gated shortcut would be inactive ~95% of the time, defeating
  the purpose. Additionally Mac's `Ctrl+Shift+-` collides with
  Orca's `_` zoom-out alias.

On some European Windows layouts, AltGr is reported by Electron as
`control + alt`, making `Ctrl+Alt+Arrow` indistinguishable from
`AltGr+Arrow`. Arrow keys are not AltGr-composable on typical layouts,
so users are not trying to type a composed character; the worst case
is an accidental history navigation. We accept this as a known quirk.

Shortcuts are registered in the same renderer-side `keydown` capture
listener that already owns `Cmd+B`, `Cmd+L`, etc. They must go through
the `isEditableTarget(e.target)` guard so they do not steal the user's
keystroke when focus is inside a TipTap editor or another input. The
shortcuts are also no-ops when `activeView !== 'terminal'`, matching
the button-visibility rule in §2.1 — navigating worktree history from
Settings or Tasks is not a meaningful action.

TipTap / RichMarkdownEditor does **not** bind Cmd/Alt+Arrow chords
(verified in `src/renderer/src/components/editor/rich-markdown-key-handler.ts`
and sibling extension files), so no collision is expected inside a
rich editor. The `isEditableTarget` guard is still applied for
consistency with other global shortcuts.

To make the shortcut work when a browser guest or a terminal has
focus, we must also add both accelerators to the main-process
`before-input-event` allowlist in `window-shortcut-policy.ts` —
same mechanism that keeps `Cmd+N` and `Cmd+L` globally reachable.
The allowlist entries must key on `input.code` (`'ArrowLeft'` /
`'ArrowRight'`) with `alt` set and `meta` on Mac (or `control` on
non-Mac). Existing policy entries (`code: 'KeyB'`, `'KeyL'`,
`'KeyN'`, …) already follow the `input.code` rule; `input.key` is
layout- / modifier-dependent and would silently drift.

## 3. Technical Architecture

### 3.1 History Model

Store lives in a small new Zustand slice
`src/renderer/src/store/slices/worktree-nav-history.ts`, exported as
`createWorktreeNavHistorySlice` (consistent with `createWorktreeSlice`,
`createTabsSlice`, `createUISlice`, and other slice patterns in
`src/renderer/src/store/slices/`), with this shape:

```ts
type WorktreeNavHistorySlice = {
  // Linear history, oldest → newest.
  worktreeNavHistory: string[]          // worktreeId[]
  // Index into worktreeNavHistory; points at the currently-active entry.
  // -1 means empty (no worktree ever activated this session).
  worktreeNavHistoryIndex: number

  recordWorktreeVisit: (worktreeId: string) => void
  goBackWorktree: () => void
  goForwardWorktree: () => void

  // Derived (computed in selectors, not persisted):
  //   canGoBackWorktree:    worktreeNavHistoryIndex > 0
  //   canGoForwardWorktree: worktreeNavHistoryIndex < worktreeNavHistory.length - 1
}
```

The name `worktreeNavHistory` is deliberate: the rest of the codebase
uses "worktree" (see `worktreesByRepo`, `activeWorktreeId`,
`setActiveWorktree`), and "workspace" is overloaded in Orca (the
workspace *view* vs. a worktree).

Semantics match a browser's session history:

- **Record on navigation** — `recordWorktreeVisit(id)` is called from
  `activateAndRevealWorktree` after the core `setActiveWorktree` step
  succeeds **and** the resulting `activeView` is `'terminal'` (see
  §2.1 / §2.2). It:
  1. No-ops if `id === worktreeNavHistory[worktreeNavHistoryIndex]`
     (re-activating the same worktree must not pollute history). The
     de-dup applies **only to the current entry**, not to earlier
     entries in the stack. A stack like `A → B → A` is valid and
     intentional: if the user was on `B` and clicked `A` from the
     sidebar, pressing Back once goes to `B`, pressing Back again goes
     to the older `A`. This matches browser behavior.
  2. Truncates any forward entries
     (`worktreeNavHistory.slice(0, index + 1)`) — "new navigation
     overwrites the forward stack" is the standard browser behavior
     users expect.
  3. Appends `id` and advances `worktreeNavHistoryIndex` by one.
  4. Caps the stack at a max length (e.g., 50). Evict from the front
     when the cap is exceeded, and decrement `worktreeNavHistoryIndex`
     by the number of entries evicted from the front (in practice
     `entries.length - MAX_HISTORY`, clamped to 0).

- **Back / Forward do not re-record** — they move the index without
  mutating the history array. Entering the handler they call the same
  core `setActiveWorktree` / view-reset logic as `activateAndRevealWorktree`,
  but set a flag (`isNavigatingHistory`) so the activation path can
  skip `recordWorktreeVisit` for that single call. The index is
  advanced **only after** the target activation's core synchronous
  step succeeds — if the target worktree is discovered to be gone
  between the skip check and the call, or activation otherwise
  returns falsy, the index stays put and the user sees no state
  drift. See §3.3 for the exact ordering.

- **Global across repos** — history is a single linear stack that
  spans every repo in the workspace. We deliberately do not maintain
  per-repo stacks: browsers don't, cross-repo jumps are rare in
  practice, and the `activateAndRevealWorktree` path already handles
  the `activeRepoId` swap transparently. If the need for per-repo
  history emerges later, the slice shape supports adding a repo-keyed
  map without disturbing existing call sites.

- **Deleted worktrees** — before navigating, skip any history entries
  whose worktree no longer exists in `worktreesByRepo` (via
  `findWorktreeById`). If the entire direction is dead, the button's
  disabled state should update — reuse a Zustand selector so the
  titlebar re-renders when `worktreesByRepo` changes.

### 3.2 Why session-scoped (not persisted)

History is deliberately **not** written to `session.json`. Reasons:

- It is transient navigation state — the jump palette and the "last
  active worktree" hydration already cover the "restore my last
  working state" use case.
- Persisting would require reconciling with the
  `hydratePersistedUI` flow and pruning entries for repos that were
  removed between launches. The extra complexity buys no real user
  value; a fresh launch starting with an empty history is the expected
  browser-like behavior.

### 3.3 Integration with `activateAndRevealWorktree`

[`src/renderer/src/lib/worktree-activation.ts`](../src/renderer/src/lib/worktree-activation.ts)
is the single choke point every worktree activation flows through
(sidebar click, jump palette, agent hovercard, issue-command flow,
external reveal). Adding the history write *here* guarantees all five
call sites populate the stack without further edits:

```ts
// inside activateAndRevealWorktree, after the core setActiveWorktree step:
// Why: `activateAndRevealWorktree` always ends in 'terminal' view (step 2),
// and Settings/Tasks transitions do not pass through this function, so no
// view-guard is needed here.
if (!state.isNavigatingHistory) {
  state.recordWorktreeVisit(worktreeId)
}
```

`goBackWorktree` / `goForwardWorktree` look roughly like:

```ts
goBackWorktree: () => {
  const state = get()
  if (state.worktreeNavHistoryIndex <= 0) return
  const targetIndex = findPrevLiveIndex(state)   // skips deleted worktrees
  if (targetIndex === null) return               // entire direction dead
  set({ isNavigatingHistory: true })
  try {
    // `activateAndRevealWorktree` returns `ActivateAndRevealResult | false`
    // (see src/renderer/src/lib/worktree-activation.ts:46–63). `false` is
    // the only observable failure signal — `setActiveWorktree` itself has
    // no failure signal, so "advance the index only on success" treats any
    // non-false return as success.
    const result = activateAndRevealWorktree(state.worktreeNavHistory[targetIndex])
    if (result !== false) set({ worktreeNavHistoryIndex: targetIndex })
  } finally {
    set({ isNavigatingHistory: false })
  }
}
```

**`findPrevLiveIndex` / `findNextLiveIndex`.**
- `findPrevLiveIndex(state)`: starts at `worktreeNavHistoryIndex - 1`,
  searches backward, returns the first index whose worktree is present
  in `worktreesByRepo` (via `findWorktreeById`), or `null` if none.
- `findNextLiveIndex(state)`: same but forward from
  `worktreeNavHistoryIndex + 1`.

**Reentrancy and flag lifetime.** The `set → call → finally set`
sequence is fully synchronous: all three happen in the same microtask,
with no `await` between them. `activateAndRevealWorktree` kicks off
async side effects (GitHub refresh, terminal hydration), but the
`recordWorktreeVisit` guard check runs inside the synchronous portion
of the activation, before those side effects begin. The flag therefore
only needs to live across that synchronous window; once
`activateAndRevealWorktree` returns, the flag is cleared in the
`finally`, and any async work completing later cannot call
`recordWorktreeVisit` (nothing in those side effects does).

**Concurrent / rapid clicks.** If the user mashes Back twice in quick
succession, each invocation runs its own independent
`set → call → finally` block. There is no interleaving, because a
single call has no suspend points between setting and clearing the
flag. The worst case is two rapid activations of adjacent history
entries; `setActiveWorktree` is idempotent under rapid repetition, so
the renderer settles on the later target cleanly. This keeps the
"what does activating mean" logic in exactly one place.

### 3.4 Disabled-state derivation

The titlebar reads two selectors from the store:

```ts
const canGoBack = useAppStore((s) =>
  s.worktreeNavHistoryIndex > 0
)
const canGoForward = useAppStore((s) =>
  s.worktreeNavHistoryIndex < s.worktreeNavHistory.length - 1
)
```

Both are cheap number comparisons — no memoisation needed, and no
structural sharing concerns. The buttons render the disabled attribute
directly off those booleans.

### 3.5 Failure Modes & Data Flow

Four paths matter. The slice stays consistent in every one:

```
Happy path (Back):
  click → set flag → activateAndRevealWorktree(target) → ok
       → advance index → clear flag → (async: GH refresh, hydrate)

Nil path (no history in that direction):
  click → canGoBack === false → button is disabled; handler no-ops.

Missing-target (worktree deleted since it was recorded):
  click → findPrev/NextLiveIndex skips dead entries
       → either lands on a live entry (happy path from there)
       → or returns null → handler no-ops, button disables on next render.

Upstream error (activation throws / returns false mid-flight):
  click → set flag → activateAndRevealWorktree(target) → !ok
       → index NOT advanced → finally clears flag
       → next render uses the unchanged index, so Back/Forward state
         is consistent with what the user actually sees.
```

The index is the single source of truth for button state, and it only
moves when an activation's synchronous core step succeeds. That
invariant is what keeps the four paths from drifting.

### 3.6 Main-process routing for terminal / browser-guest focus

When a terminal or a browser guest has focus, the accelerator is
intercepted in the main process before the renderer sees it —
mirroring how `Cmd+N` / `Cmd+L` already work. There are **two**
`before-input-event` handlers in play, both of which must forward
this chord:

1. The main-window handler in `createMainWindow.ts` (the same
   fan-out that currently emits `ui:toggleLeftSidebar` etc.).
2. The guest handler in `src/main/browser/browser-guest-ui.ts:216`,
   which fires when a browser guest `webContents` has focus and
   otherwise bypasses (1). That handler today has its own bespoke
   switch for guest-specific chords (`Cmd+T` → new browser tab,
   `Cmd+L` → focus address bar, `Cmd+Shift+B` → new browser tab,
   `Cmd+Shift+[`/`]` → switch tab, etc.), alongside a pass-through
   for the shared allowlist via `resolveWindowShortcutAction`.

The plumbing:

- `window-shortcut-policy.ts` gains a new action variant
  `{ type: 'worktreeHistoryNavigate'; direction: 'back' | 'forward' }`
  on the `WindowShortcutAction` tagged union.
- `resolveWindowShortcutAction` matches `code === 'ArrowLeft'`
  (direction `'back'`) / `'ArrowRight'` (direction `'forward'`) via
  a dedicated `isHistoryNavigateChord` predicate, checked **before**
  the existing `isWindowShortcutModifierChord` gate.
- Both handlers call `resolveWindowShortcutAction(input, platform)`
  up top; any non-null action the handler is willing to forward gets
  sent via its channel. The guest handler's existing bespoke switch
  stays for guest-only shortcuts. This is the cleaner factoring over
  keeping two parallel chord checks in lockstep.
- The IPC channel is `ui:worktreeHistoryNavigate` and it carries the
  direction. Preload bridges it in the same pattern as the existing
  `ui:*` channels.
- Renderer-side, the existing `useIpcEvents` hook
  (`src/renderer/src/hooks/useIpcEvents.ts:25`) gains one more
  `window.api.ui.onWorktreeHistoryNavigate(...)` subscription next to
  the other `ui:*` subscriptions; the listener calls
  `goBackWorktree` / `goForwardWorktree` directly.

Why a dedicated predicate rather than extending the existing chord
helper: `isWindowShortcutModifierChord`
(`src/shared/window-shortcut-policy.ts:19–25`) deliberately rejects
any chord that includes Alt — its other callers (zoom, sidebar
toggles, jump-palette indices) must **not** steal Alt-combinations
used by shells and readline. The history-navigate chord is the first
policy-allowlist entry that intentionally matches Alt, so we keep the
old helper's `!alt` invariant intact and add a separate predicate.

```ts
// window-shortcut-policy.ts
function isHistoryNavigateChord(
  input: WindowShortcutInput,
  platform: NodeJS.Platform
): boolean {
  const primary = platform === 'darwin' ? input.meta : input.control
  // Why: excluding Shift reserves Cmd/Ctrl+Alt+Shift+Arrow for future chords
  // (e.g., "close back/forward entry" or cross-stack selection) without
  // taking a breaking-change hit on the v1 chord binding.
  return Boolean(primary) && Boolean(input.alt) && !input.shift
}

// at the top of resolveWindowShortcutAction, BEFORE the existing
// isWindowShortcutModifierChord gate:
if (isHistoryNavigateChord(input, platform)) {
  if (input.code === 'ArrowLeft')  return { type: 'worktreeHistoryNavigate', direction: 'back' }
  if (input.code === 'ArrowRight') return { type: 'worktreeHistoryNavigate', direction: 'forward' }
  // fall through returns null; Cmd/Ctrl+Alt+<other-arrow-or-non-arrow> continues
  // to the renderer/PTTY because the caller's handler short-circuits on null.
}
```

Preload signature (mirrors `onJumpToWorktreeIndex` / `onToggleLeftSidebar`
in `src/preload/api-types.d.ts:608–617`):

```ts
// preload index.ts / api-types.d.ts — on window.api.ui
onWorktreeHistoryNavigate: (
  callback: (direction: 'back' | 'forward') => void
) => () => void   // returns unsubscribe
```

Renderer listener (added to `useIpcEvents`):

```ts
// src/renderer/src/hooks/useIpcEvents.ts — adjacent to existing ui:* subs
unsubs.push(
  window.api.ui.onWorktreeHistoryNavigate((direction) => {
    const store = useAppStore.getState()
    if (direction === 'back') store.goBackWorktree()
    else store.goForwardWorktree()
  })
)
```

Guest-handler update (`src/main/browser/browser-guest-ui.ts:216`):
add a dedicated **early-return block** above the existing
`if (!isWindowShortcutModifierChord(...)) return` gate. Without the
early `return`, control flow falls through into the gate-rejection
path and the keystroke is silently dropped. The block:
1. Calls `resolveWindowShortcutAction(input, process.platform)` (or
   the `isHistoryNavigateChord` predicate directly — whichever matches
   the factoring decision above).
2. If the returned action is
   `{ type: 'worktreeHistoryNavigate', direction }`, calls
   `renderer.send('ui:worktreeHistoryNavigate', action.direction)`,
   `event.preventDefault()`, and `return`.
3. Otherwise falls through to the existing gate and bespoke switch
   unchanged.

```ts
// browser-guest-ui.ts — at the top of the before-input-event handler,
// BEFORE the existing isWindowShortcutModifierChord gate at line 216.
const action = resolveWindowShortcutAction(input, process.platform)
if (action?.type === 'worktreeHistoryNavigate') {
  const renderer = resolveRenderer(browserTabId)
  if (renderer) {
    renderer.send('ui:worktreeHistoryNavigate', action.direction)
    event.preventDefault()
  }
  return
}
// ...existing gate and bespoke switch continue unchanged
```

The existing bespoke switch for guest-only chords (Cmd+T, Cmd+L,
Cmd+Shift+B, Cmd+Shift+[/]) stays untouched.

Main-window handler update (`src/main/window/createMainWindow.ts:355–397`):
add a case alongside `jumpToWorktreeIndex` at ~line 393:

```ts
} else if (action.type === 'worktreeHistoryNavigate') {
  mainWindow.webContents.send('ui:worktreeHistoryNavigate', action.direction)
}
```

`event.preventDefault()` has already been called at line 353 for any
non-null action, so no additional prevention is needed here.

## 4. Edge Cases

- **Same-worktree re-activation** — de-dup (§3.1 bullet 1) only
  applies to the *current* entry. A stack like `A → B → A` is valid
  (user was on `B`, clicked `A` in the sidebar) and Back from the last
  `A` correctly goes to `B`; Back again goes to the earlier `A`. This
  is the browser's behavior and is intentional.
- **Sidebar repo-filter change during history navigation** — the
  target worktree's repo may currently be filtered out.
  `activateAndRevealWorktree` already clears the filter in step 5 when
  necessary, so the history path inherits that behavior for free.
- **Cross-repo navigation** — history is global across repos (§3.1).
  Step 1 of `activateAndRevealWorktree` handles the `activeRepoId`
  swap, so Back/Forward across a repo boundary works with no extra
  logic.
- **Non-terminal views (Settings / Tasks / Landing)** — the buttons
  are hidden in these views (§2.1) and the keyboard shortcuts no-op,
  so Back/Forward never fire from them. History is also not
  *recorded* while `activeView !== 'terminal'`. To return to a
  previous worktree from Settings, the user clicks a sidebar entry or
  uses the jump palette; once `activeView` flips back to `'terminal'`
  the Back/Forward pair reappears with the stack intact.
- **Forward stack truncated on new navigation** — after Back, if the
  user activates a different worktree from the sidebar, the forward
  stack is wiped and the Forward button flips to disabled. This is
  the standard browser behavior and we ship it as-is; the abrupt
  enabled → disabled transition is the only signal, and users are
  already fluent in this pattern. (See §2.2 for the UX discussion.)
- **Rapid double-click on Back (or Forward)** — each click runs a
  self-contained `set flag → activate → clear flag` block (§3.3) and
  decrements the index by exactly one. There is no interleaving and
  no way for the flag to leak across clicks, even if the first
  click's async side effects (GitHub refresh) are still in flight
  when the second click fires. The renderer settles on whichever
  target is activated last.
- **Stack eviction at cap (50)** — when eviction decrements
  `worktreeNavHistoryIndex`, the user visibly loses old forward
  history, but the *current* entry stays pinned. Forward/back still
  work against the visible window.
- **Worktree deleted while in history** — when Back/Forward
  encounters a missing worktree, it silently advances past it. We do
  *not* surface a "3 deleted worktrees skipped" toast or other
  signal: mid-session worktree deletion is rare, and a silent skip
  keeps the buttons behaving as cheap muscle-memory controls. We do
  *not* prune entries from the array proactively either; that would
  risk surprising index shifts if a worktree with the same id were
  ever re-created.

## 5. Implementation Checklist

1. New slice `src/renderer/src/store/slices/worktree-nav-history.ts`
   with fields and actions from §3.1. Wire it into the root store
   (`src/renderer/src/store/index.ts`).
2. Hook `recordWorktreeVisit` into `activateAndRevealWorktree`
   behind the `isNavigatingHistory` guard only (§3.3 explains why no
   view-guard is needed — `activateAndRevealWorktree` always routes
   to the terminal view).
3. In `App.tsx`, read `canGoBack` / `canGoForward`, add the two
   buttons to `titlebarLeftControls` after the agent badge, and
   render them **only when `activeView === 'terminal'`** (§2.1).
   Wire `onClick` handlers and tooltips.
4. Add Back/Forward handlers to the existing `keydown` capture
   listener in `App.tsx`, with the `isEditableTarget` guard, no-oped
   when `activeView !== 'terminal'`. Match on
   `event.code === 'ArrowLeft'` / `'ArrowRight'` with the modifier
   check (`meta`+`alt` on Mac, `ctrl`+`alt` elsewhere; see §2.5).
   Tooltip strings (§2.4) must mirror the active platform.
5. Add both accelerators to `window-shortcut-policy.ts` using
   `code: 'ArrowLeft'` / `code: 'ArrowRight'` (not `input.key`),
   with `alt` set and `meta` on Mac (or `control` on non-Mac), so
   they work when terminal / browser-guest focus would otherwise
   swallow them. The policy returns a new
   `{ type: 'worktreeHistoryNavigate'; direction: 'back' | 'forward' }`
   action; see §3.6 for the main-process → renderer plumbing.
6. Tests:
   - Unit: slice reducer behavior (record, truncate forward, cap at
     50, de-dup on current entry only — verify `A → B → A` is a valid
     stack).
   - Unit: `activateAndRevealWorktree` records history on normal
     activation and skips it when `isNavigatingHistory` is set.
   - Unit: two rapid sequential Back presses each decrement the index
     by exactly one, even if the first activation's async side
     effects are still in flight (reentrancy / flag-lifetime
     regression guard for §3.3).
   - Integration: clicking Back after navigating A → B activates A;
     clicking Forward returns to B; pressing Back again after a
     truncating navigation disables forward.
   - Integration: delete the currently-active worktree (the one
     `worktreeNavHistoryIndex` points at); verify Back still skips
     correctly, Forward still skips correctly, and both buttons
     disable when no live entry remains in either direction.
   - Integration: fire a simulated `before-input-event` with
     `meta+alt+ArrowLeft` (or `control+alt+ArrowLeft` off-Mac) into
     the window-shortcut handler; assert the renderer receives
     `ui:worktreeHistoryNavigate` with direction `'back'` and that
     `goBackWorktree` is invoked. Repeat for `ArrowRight` / forward.
     Repeat for a browser-guest focused case (the
     `browser-guest-ui.ts` handler path).

## 6. Out of Scope

- **Persisting history across app restarts** (§3.2).
- **Per-tab navigation history within a worktree** — this feature is
  strictly worktree-level. Tab-level history is a separate concern
  that can reuse the same slice shape if needed later.
- **Long-press to show a dropdown of recent entries** (browser-style).
  Easy to add later if users ask; the history array already supports
  it.
- **Mouse side-buttons 3/4 (browser-back / browser-forward).** Many
  mice expose these and users expect them to trigger navigation (e.g.,
  Superset wires them up via a `mouseup` listener on `window`). Left
  out of v1 to keep the surface small and because the feature is
  worktree-scoped rather than page-scoped; the slice is shaped so a
  future `mouseup` listener can reuse `goBackWorktree` /
  `goForwardWorktree` unchanged.
