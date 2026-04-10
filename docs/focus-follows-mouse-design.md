# Focus-Follows-Mouse for Terminal Panes

**Status:** Draft
**Date:** 2026-04-08

## Summary

Add a Ghostty-style `focus-follows-mouse` behavior to Orca's terminal panes: when enabled, hovering a split makes it the active pane (cursor focus + input routing + opacity update) without requiring a click. Scoped to splits within a single tab, default off, immediate on `mouseenter`. Safety guards preserve text selections, pane drags, window-focus semantics, and overlays.

## Motivation

Orca's terminal panes already borrow heavily from Ghostty's look and feel (themes, dividers, drag handles, close dialog, URL tooltip). Focus-follows-mouse is one of the few Ghostty interaction conventions Orca doesn't yet mirror. Users coming from Ghostty expect it; users who've never used it can leave the default off and see no change.

## Scope

**In scope:**

- Hovering a terminal split in the current tab activates it when the setting is enabled.
- A new `GlobalSettings.terminalFocusFollowsMouse` boolean persisted in user settings.
- A new toggle in Settings → Terminal → Pane Styling.
- Full unit test coverage of the gating logic.

**Out of scope:**

- Cross-tab hover activation (hovering a background tab does nothing).
- Hovering non-terminal panes (file editor, source control, sidebars) — this setting only affects terminal splits.
- Adjustable hover delay / settle time. Immediate switching matches Ghostty and is what users asking for Ghostty parity expect.
- Migrating `PaneStyleOptions` into a split style-vs-behavior type. Bundling that refactor here would balloon the diff for marginal clarity. Left as a follow-up for when a second behavior flag lands.

## Non-Goals

- Cross-window focus. If Orca isn't the OS-focused window, hovering a pane must not switch focus.
- Breaking existing click-to-focus. Clicking a pane must continue to work exactly as today; this feature is additive.

## Design

### Data model and settings plumbing

**New field on `GlobalSettings`** (`src/shared/types.ts`):

```ts
terminalFocusFollowsMouse: boolean
```

**Default value** (`src/shared/constants.ts` → `getDefaultSettings`):

```ts
terminalFocusFollowsMouse: false
```

Default off matches Ghostty. Existing users upgrading receive the default automatically since `getDefaultSettings` is used as the fallback for missing fields on read — no migration needed.

**Extension of `PaneStyleOptions`** (`src/renderer/src/lib/pane-manager/pane-manager-types.ts`):

```ts
export type PaneStyleOptions = {
  splitBackground?: string
  paneBackground?: string
  inactivePaneOpacity?: number
  activePaneOpacity?: number
  opacityTransitionMs?: number
  dividerThicknessPx?: number
  // Why this behavior flag lives on "style" options: this type is already
  // the single runtime-settings bag the PaneManager exposes. Splitting into
  // separate style vs behavior types is a refactor worth its own change when
  // a second behavior flag lands. See docs/focus-follows-mouse-design.md.
  focusFollowsMouse?: boolean
}
```

**Plumbing path** (same pattern already used by `terminalInactivePaneOpacity`):

1. `GlobalSettings.terminalFocusFollowsMouse` — persisted
2. `resolvePaneStyleOptions` in `src/renderer/src/lib/terminal-theme.ts:103` extracts the style-related fields from `GlobalSettings` and returns them. Add `'terminalFocusFollowsMouse'` to the `Pick<GlobalSettings, ...>` parameter union, and add `focusFollowsMouse: settings.terminalFocusFollowsMouse` to the returned object (no clamping needed — boolean pass-through, unlike the existing numeric fields that go through `clampNumber`).
3. `applyTerminalAppearance` in `src/renderer/src/components/terminal-pane/terminal-appearance.ts:48` calls `manager.setPaneStyleOptions({...})` — add `focusFollowsMouse: paneStyles.focusFollowsMouse` to that object literal.
4. `PaneManager.setPaneStyleOptions()` stores into `this.styleOptions`. The `handlePaneMouseEnter` method reads `this.styleOptions.focusFollowsMouse` fresh on every event, so toggling the setting takes effect immediately without re-wiring listeners.

### Runtime event wiring

**Pure gate helper** — extracted to a new file so it can be unit tested without a DOM.

`src/renderer/src/lib/pane-manager/focus-follows-mouse.ts`:

```ts
export type FocusFollowsMouseInput = {
  featureEnabled: boolean
  activePaneId: number | null
  hoveredPaneId: number
  mouseButtons: number // from MouseEvent.buttons bitmask
  windowHasFocus: boolean // from document.hasFocus()
  managerDestroyed: boolean
}

/** Pure gate: returns true iff the hovered pane should be activated.
 *  Isolated from DOM so it can be unit-tested without an environment. */
export function shouldFollowMouseFocus(input: FocusFollowsMouseInput): boolean {
  if (!input.featureEnabled) return false
  if (input.managerDestroyed) return false
  if (input.activePaneId === input.hoveredPaneId) return false
  // Why event.buttons !== 0: any held mouse button means a selection or a
  // drag is in progress. Switching focus mid-drag would break xterm.js text
  // selection and the pane drag-to-reorder flow. This single check also
  // covers drag-to-reorder: the drag is always button-held, so buttons is
  // always non-zero during it. No separate drag-state gate needed.
  if (input.mouseButtons !== 0) return false
  // Why document.hasFocus: if Orca isn't the OS-focused window, the mouse
  // event is from the user passing through on their way to another app.
  // We must not hijack focus in that case. Also returns false when DevTools
  // is focused (DevTools runs in a separate WebContents) — accepted.
  if (!input.windowHasFocus) return false
  return true
}
```

**Updated `createPaneDOM` signature** (`src/renderer/src/lib/pane-manager/pane-lifecycle.ts`):

```ts
export function createPaneDOM(
  id: number,
  options: PaneManagerOptions,
  dragState: DragReorderState,
  dragCallbacks: DragReorderCallbacks,
  onPointerDown: (id: number) => void,
  onMouseEnter: (id: number, event: MouseEvent) => void // NEW
): ManagedPaneInternal
```

**New listener** attached in `createPaneDOM` next to the existing `pointerdown` listener:

```ts
container.addEventListener('mouseenter', (event) => {
  onMouseEnter(id, event)
})
```

The pane DOM layer stays dumb — it knows nothing about settings, active state, or window focus. All gating logic lives in the PaneManager callback.

**PaneManager wiring** (`src/renderer/src/lib/pane-manager/pane-manager.ts`, inside `createPaneInternal`):

```ts
private createPaneInternal(): ManagedPaneInternal {
  const id = this.nextPaneId++
  const pane = createPaneDOM(
    id,
    this.options,
    this.dragState,
    this.getDragCallbacks(),
    (paneId) => {
      if (!this.destroyed && this.activePaneId !== paneId) {
        this.setActivePane(paneId, { focus: true })
      }
    },
    (paneId, event) => {
      this.handlePaneMouseEnter(paneId, event)
    }
  )
  this.panes.set(id, pane)
  return pane
}

/** Focus-follows-mouse entry point. Collects gate inputs from the manager
 *  and delegates to the pure gate helper.
 *
 *  Invariant for future contributors: modal overlays (context menus, close
 *  dialogs, command palette) must be rendered as portals/siblings OUTSIDE
 *  the pane container. If a future overlay is rendered inside a .pane
 *  element, mouseenter will still fire on the pane underneath and this
 *  handler will incorrectly switch focus. Keep overlays out of the pane. */
private handlePaneMouseEnter(paneId: number, event: MouseEvent): void {
  if (
    shouldFollowMouseFocus({
      featureEnabled: this.styleOptions.focusFollowsMouse ?? false,
      activePaneId: this.activePaneId,
      hoveredPaneId: paneId,
      mouseButtons: event.buttons,
      windowHasFocus: document.hasFocus(),
      managerDestroyed: this.destroyed
    })
  ) {
    this.setActivePane(paneId, { focus: true })
  }
}
```

**Why no explicit drag-state gate:** An earlier draft of this design included a `dragSourcePaneId !== null` check as belt-and-suspenders. Verification against `src/renderer/src/lib/pane-manager/pane-drag-reorder.ts:77-103` showed it's strictly redundant:

- The drag only activates while the user is holding a mouse button (pointerdown → drag threshold → pointerup). During that entire window, `event.buttons !== 0` on any mouseenter.
- `dragSourcePaneId` is unconditionally cleared at line 101 inside the `if (dragging)` branch of the pointerup handler, so it cannot outlive a pointerup.
- Therefore `mouseButtons !== 0` is sufficient on its own. Adding a second check would be dead code.

### Settings UI

**Placement** — under the existing "Pane Styling" section in `src/renderer/src/components/settings/TerminalPane.tsx`, below the `<div className="grid gap-4 md:grid-cols-2">` that holds Inactive Pane Opacity + Divider Thickness. The new toggle is a full-width row (toggles don't balance well next to numeric fields in a 2-column grid).

**Toggle shape** — mirrors the existing `role="switch"` pattern used by e.g. "Nest Workspaces" in `GeneralPane.tsx`:

```tsx
<SearchableSetting
  title="Focus Follows Mouse"
  description="Hovering a terminal pane activates it without needing to click. Mirrors Ghostty's focus-follows-mouse setting."
  keywords={['focus', 'follows', 'mouse', 'hover', 'pane', 'ghostty', 'active']}
  className="flex items-center justify-between gap-4 px-1 py-2"
>
  <div className="space-y-0.5">
    <Label>Focus Follows Mouse</Label>
    <p className="text-xs text-muted-foreground">
      Hovering a terminal pane activates it without needing to click. Mirrors Ghostty&apos;s
      focus-follows-mouse setting. Selections and window switching stay safe.
    </p>
  </div>
  <button
    role="switch"
    aria-checked={settings.terminalFocusFollowsMouse}
    onClick={() =>
      updateSettings({
        terminalFocusFollowsMouse: !settings.terminalFocusFollowsMouse
      })
    }
    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
      settings.terminalFocusFollowsMouse ? 'bg-foreground' : 'bg-muted-foreground/30'
    }`}
  >
    <span
      className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
        settings.terminalFocusFollowsMouse ? 'translate-x-4' : 'translate-x-0.5'
      }`}
    />
  </button>
</SearchableSetting>
```

**Settings search integration** — add a new entry to `TERMINAL_PANE_STYLE_SEARCH_ENTRIES` in `src/renderer/src/components/settings/terminal-search.ts:34` (alongside "Inactive Pane Opacity" and "Divider Thickness"):

```ts
{
  title: 'Focus Follows Mouse',
  description: 'Hovering a terminal pane activates it without needing to click.',
  keywords: ['focus', 'follows', 'mouse', 'hover', 'pane', 'ghostty', 'active']
}
```

This surfaces the toggle in the settings search box for queries like "focus", "hover", or "ghostty". No changes needed to `TERMINAL_PANE_SEARCH_ENTRIES` (the aggregator) since it spreads `TERMINAL_PANE_STYLE_SEARCH_ENTRIES` automatically.

### Edge cases

**Gate-covered (code enforces):**

| Case                            | Gate                                                                                                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mouse button held mid-selection | `mouseButtons !== 0`                                                                                                                                                                                                   |
| Mid-drag-to-reorder             | `mouseButtons !== 0` (drag is always button-held)                                                                                                                                                                      |
| Orca window unfocused (alt-tab) | `!document.hasFocus()`                                                                                                                                                                                                 |
| DevTools panel focused          | `!document.hasFocus()` — DevTools runs in a separate WebContents so the main document loses focus. Feature pauses until DevTools is closed or the pane is clicked. Acceptable — same behavior as any other focus loss. |
| Hover the already-active pane   | `activePaneId === hoveredPaneId`                                                                                                                                                                                       |
| Manager destroyed mid-event     | `managerDestroyed`                                                                                                                                                                                                     |

**Implicitly safe (relies on platform behavior, documented):**

- **Context menus / close-confirm dialogs / command palette** — These render as React portals above the pane DOM. `mouseenter` does not reach the pane when an overlay is open. If a future contributor ever renders an overlay _inside_ the pane container, this assumption breaks — a code comment flags this.
- **Tab / worktree switching** — Hidden PaneManagers' DOM doesn't receive events. No cross-manager interference possible.
- **Single-pane layouts** — The `activePaneId === hoveredPaneId` early-return handles this with no special case.
- **Right-click** — `contextmenu` doesn't trigger `mouseenter` (no boundary crossing). Existing right-click behavior is preserved.

**Intentionally accepted quirks:**

- **Setting toggled ON while hovering a non-active pane** → feature doesn't kick in until next `mouseenter`. User must wiggle the mouse. The fix (track last hovered pane and replay on setting change) adds persistent state for a rare case. Not worth it.
- **Traversal flicker** (A → C via B on a three-pane layout) → briefly focuses B. Accepted as the cost of Ghostty-parity immediate switching. Confirmed during brainstorming.
- **Window-resize-under-stationary-mouse** → if pane boundaries cross the cursor during a resize, focus can shift to the newly-hovered pane even though the user didn't move the mouse. Arguably correct; adding a "suppress during resize" gate introduces fragile state.

### Error handling

The mouseenter handler does no I/O, no promises, no external state lookups. No error surface worth defending:

- `document.hasFocus()` — synchronous boolean, cannot throw
- `event.buttons` — number, cannot throw
- `this.styleOptions.focusFollowsMouse ?? false` — missing settings fail safe (feature off)
- `setActivePane` — already handles pane-not-found silently at `pane-manager.ts:188`

No try/catch added. If `setActivePane` throws, propagating to the window `error` handler is the correct failure mode — silently swallowing would hide a real bug.

### Testing strategy

**Constraint:** vitest runs with `environment: 'node'` (no jsdom). No synthetic event dispatch in automated tests.

**1. Unit tests — `src/renderer/src/lib/pane-manager/focus-follows-mouse.test.ts`**

Table of inputs against `shouldFollowMouseFocus`, one case per gate plus happy paths. Expected coverage: every branch.

- Happy path: all gates pass → `true`
- Feature disabled → `false`
- Manager destroyed → `false`
- Hover the already-active pane → `false`
- Mouse button held (primary `buttons=1`, secondary `=2`, both `=3`) → `false` each
- Window lacks OS focus → `false`
- `activePaneId === null` (theoretically-unreachable defensive case — `createInitialPane` always sets `activePaneId` before mouse events are possible, but the gate logic must still behave correctly if this state ever occurs) → `true`

**2. Manual smoke test checklist (PR description)**

- [ ] Toggle persists across app restart.
- [ ] Multi-split: hovering an inactive pane activates it.
- [ ] Start text selection in pane A, drag into pane B. Selection extends normally; focus does NOT switch mid-drag.
- [ ] Drag a pane by its drag-handle (the top strip that appears on hover). Release on a drop zone. Focus/activation does NOT flicker during the drag.
- [ ] Cmd-Tab out, move mouse over a different Orca pane, Cmd-Tab back. Previously-active pane still active.
- [ ] Open DevTools, focus the DevTools panel, move mouse over a different Orca pane. Focus does NOT switch. Close DevTools, wiggle mouse → focus-follows-mouse resumes.
- [ ] Open close-terminal confirmation, hover a different pane. No focus shift.
- [ ] Hover a URL in an inactive pane. Focus-follows-mouse activates the pane. Verify the `Cmd+click to open` URL tooltip still appears correctly on the newly-activated pane (tests for interaction between our `setActivePane → terminal.focus()` call and xterm.js's `WebLinksAddon` hover tracking).
- [ ] Disable the setting. Hover does nothing; click still works.
- [ ] Single-pane layout with the setting enabled. No crash, pane stays focused.
- [ ] Three-pane layout, quick A→C sweep. Traversal flicker visible but tolerable.

**Explicitly not tested:**

- DOM event dispatch integration (no jsdom, not worth adding)
- Settings UI render (no precedent in the codebase for per-control UI tests)
- Electron's `document.hasFocus()` semantics (trust the platform)

## Files Touched

| File                                                               | Change                                                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `src/shared/types.ts`                                              | Add `terminalFocusFollowsMouse: boolean` to `GlobalSettings`                                       |
| `src/shared/constants.ts`                                          | Default `terminalFocusFollowsMouse: false` in `getDefaultSettings`                                 |
| `src/renderer/src/lib/pane-manager/pane-manager-types.ts`          | Add `focusFollowsMouse?: boolean` to `PaneStyleOptions` with a commented rationale                 |
| `src/renderer/src/lib/pane-manager/focus-follows-mouse.ts`         | **New file.** Pure `shouldFollowMouseFocus` gate helper                                            |
| `src/renderer/src/lib/pane-manager/focus-follows-mouse.test.ts`    | **New file.** Unit tests for the gate helper                                                       |
| `src/renderer/src/lib/pane-manager/pane-lifecycle.ts`              | Add `onMouseEnter` param to `createPaneDOM`; attach `mouseenter` listener on pane container        |
| `src/renderer/src/lib/pane-manager/pane-manager.ts`                | Pass new callback from `createPaneInternal`; add `handlePaneMouseEnter` private method             |
| `src/renderer/src/components/settings/TerminalPane.tsx`            | Add `SearchableSetting` toggle under Pane Styling                                                  |
| `src/renderer/src/components/settings/terminal-search.ts`          | Add entry to `TERMINAL_PANE_STYLE_SEARCH_ENTRIES`                                                  |
| `src/renderer/src/lib/terminal-theme.ts`                           | Extend `resolvePaneStyleOptions` to pass `focusFollowsMouse` through                               |
| `src/renderer/src/components/terminal-pane/terminal-appearance.ts` | Add `focusFollowsMouse: paneStyles.focusFollowsMouse` to the `setPaneStyleOptions` call at line 48 |

## Build Order

1. Add `terminalFocusFollowsMouse` to `GlobalSettings` type and default. Build passes; no behavior change.
2. Add `focusFollowsMouse` to `PaneStyleOptions`. Build passes; no behavior change.
3. Create `focus-follows-mouse.ts` pure helper + `focus-follows-mouse.test.ts`. Tests pass.
4. Update `createPaneDOM` signature and wire `mouseenter` listener.
5. Add `handlePaneMouseEnter` in `PaneManager` and the new callback in `createPaneInternal`.
6. Thread `terminalFocusFollowsMouse → focusFollowsMouse` through `resolvePaneStyleOptions` and `applyTerminalAppearance`.
7. Add the settings toggle UI in `TerminalPane.tsx` and the search entry in `terminal-search.ts`.
8. Run the manual smoke test checklist against a local build.

## Risks & Open Questions

**Risk: traversal flicker on three-pane layouts may feel worse than expected.** Mitigation: the user explicitly chose immediate switching for Ghostty parity. If complaints arrive, adding a `terminalFocusFollowsMouseDelayMs` setting is a clean follow-up without schema breakage.

**Risk: overlay assumption could break if a future contributor renders a modal inside the pane container.** Mitigation: a code comment on `handlePaneMouseEnter` documents the "overlays must live outside the pane container" invariant so it surfaces during review of any future overlay changes.

**Open: should the setting description link to Ghostty's docs?** Currently the description just says "Mirrors Ghostty's focus-follows-mouse setting." No external link. If Orca's settings UI supports hyperlinks in descriptions elsewhere, we could link to Ghostty's config docs — otherwise leave as plain text. Not a blocker.
