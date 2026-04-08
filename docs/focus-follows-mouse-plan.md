# Focus-Follows-Mouse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Ghostty-style `focus-follows-mouse` behavior to Orca's terminal panes. When enabled, hovering a split activates it (cursor focus, input routing, opacity update) without a click.

**Architecture:** Extend `PaneStyleOptions` with a `focusFollowsMouse?: boolean` flag. Attach a `mouseenter` listener on each pane container in `createPaneDOM`. Delegate all gating logic to a pure `shouldFollowMouseFocus` helper (no DOM, unit-testable) that checks five gates: feature enabled, manager not destroyed, not already active, no mouse button held, window has OS focus. Thread the setting through the existing `resolvePaneStyleOptions → applyTerminalAppearance → setPaneStyleOptions` pipeline.

**Tech Stack:** TypeScript, Electron (renderer), React (settings UI), xterm.js (terminal), vanilla DOM (PaneManager), vitest (tests, node environment).

**Spec:** [docs/focus-follows-mouse-design.md](./focus-follows-mouse-design.md) — read this first for design rationale, edge case reasoning, and the full manual smoke test checklist.

---

## File Structure

**New files (2):**

- `src/renderer/src/lib/pane-manager/focus-follows-mouse.ts` — Pure gate helper. Exports `FocusFollowsMouseInput` type and `shouldFollowMouseFocus(input)` function. Zero DOM dependencies.
- `src/renderer/src/lib/pane-manager/focus-follows-mouse.test.ts` — Unit tests for the pure helper. Table-style assertions, one case per gate.

**Modified files (9):**

- `src/shared/types.ts` — Add `terminalFocusFollowsMouse: boolean` field to `GlobalSettings` type.
- `src/shared/constants.ts` — Add `terminalFocusFollowsMouse: false` default in `getDefaultSettings`.
- `src/renderer/src/lib/pane-manager/pane-manager-types.ts` — Add `focusFollowsMouse?: boolean` to `PaneStyleOptions`.
- `src/renderer/src/lib/pane-manager/pane-lifecycle.ts` — Add `onMouseEnter` parameter to `createPaneDOM`, attach a `mouseenter` listener on the pane container.
- `src/renderer/src/lib/pane-manager/pane-manager.ts` — Add `handlePaneMouseEnter` private method. Pass the new callback from `createPaneInternal`.
- `src/renderer/src/lib/terminal-theme.ts` — Extend `resolvePaneStyleOptions` to pass `focusFollowsMouse` through.
- `src/renderer/src/components/terminal-pane/terminal-appearance.ts` — Add `focusFollowsMouse: paneStyles.focusFollowsMouse` to the `setPaneStyleOptions` call.
- `src/renderer/src/components/settings/TerminalPane.tsx` — Add a `SearchableSetting` toggle under Pane Styling.
- `src/renderer/src/components/settings/terminal-search.ts` — Add an entry to `TERMINAL_PANE_STYLE_SEARCH_ENTRIES`.

Each task below produces a standalone, type-checking commit. The sequence is chosen so the build stays green at every step.

---

## Task 1: Add `terminalFocusFollowsMouse` to GlobalSettings

**Files:**

- Modify: `src/shared/types.ts` (insert field in `GlobalSettings` type around line 311)
- Modify: `src/shared/constants.ts` (insert default in `getDefaultSettings` around line 83)

Because `GlobalSettings` is an exact type, both the type declaration and the `getDefaultSettings` initializer must be updated together or `tsc` fails. Combine both edits in one commit.

- [ ] **Step 1: Add the field to the GlobalSettings type**

Edit `src/shared/types.ts`. Find the line with `terminalDividerThicknessPx: number` (near line 311) and add the new field immediately after it:

```ts
terminalDividerThicknessPx: number
terminalFocusFollowsMouse: boolean
terminalScrollbackBytes: number
```

- [ ] **Step 2: Add the default value in getDefaultSettings**

Edit `src/shared/constants.ts`. Find the line `terminalDividerThicknessPx: 3,` in `getDefaultSettings` (near line 83) and add the default immediately after it:

```ts
    terminalDividerThicknessPx: 3,
    terminalFocusFollowsMouse: false,
    terminalScrollbackBytes: 10_000_000,
```

**Why default `false`:** Matches Ghostty's default. Existing users upgrading receive this default automatically because `src/main/persistence.ts:73-75` merges persisted settings over `defaults.settings` (`{ ...defaults.settings, ...parsed.settings }`), so any new field not in the persisted JSON falls through to the default. No explicit migration needed.

- [ ] **Step 3: Run typecheck to verify both edits**

Run: `pnpm run tc:web && pnpm run tc:node`
Expected: Both pass. No output beyond the tsgo banner.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts
git commit -m "feat: add terminalFocusFollowsMouse to GlobalSettings (default off)"
```

---

## Task 2: Extend `PaneStyleOptions` with `focusFollowsMouse`

**Files:**

- Modify: `src/renderer/src/lib/pane-manager/pane-manager-types.ts` (line 23-30, the `PaneStyleOptions` type)

- [ ] **Step 1: Add the field with a commented rationale**

Edit `src/renderer/src/lib/pane-manager/pane-manager-types.ts`. Replace the existing `PaneStyleOptions` type definition (lines 23-30) with:

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
  // separate style vs behavior types is a refactor worth its own change
  // when a second behavior flag lands. See docs/focus-follows-mouse-design.md.
  focusFollowsMouse?: boolean
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm run tc:web`
Expected: Pass.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/pane-manager/pane-manager-types.ts
git commit -m "refactor: add focusFollowsMouse to PaneStyleOptions type"
```

---

## Task 3: Create the pure `shouldFollowMouseFocus` gate helper (TDD)

**Files:**

- Create: `src/renderer/src/lib/pane-manager/focus-follows-mouse.ts`
- Create: `src/renderer/src/lib/pane-manager/focus-follows-mouse.test.ts`

This is the only part of the feature with isolated business logic, so it's the only part we can TDD. We write the test file first, run it to see it fail, then create the implementation to make it pass.

- [ ] **Step 1: Write the failing test file**

Create `src/renderer/src/lib/pane-manager/focus-follows-mouse.test.ts` with the following contents:

```ts
import { describe, expect, it } from 'vitest'
import { shouldFollowMouseFocus, type FocusFollowsMouseInput } from './focus-follows-mouse'

describe('shouldFollowMouseFocus', () => {
  // Base input where every gate passes. Individual tests flip one field
  // at a time to assert that each gate blocks focus independently.
  const base: FocusFollowsMouseInput = {
    featureEnabled: true,
    activePaneId: 1,
    hoveredPaneId: 2,
    mouseButtons: 0,
    windowHasFocus: true,
    managerDestroyed: false
  }

  it('switches focus when all gates pass', () => {
    expect(shouldFollowMouseFocus(base)).toBe(true)
  })

  it('blocks when the feature is disabled', () => {
    expect(shouldFollowMouseFocus({ ...base, featureEnabled: false })).toBe(false)
  })

  it('blocks when the manager is destroyed', () => {
    expect(shouldFollowMouseFocus({ ...base, managerDestroyed: true })).toBe(false)
  })

  it('blocks when hovering the already-active pane', () => {
    expect(shouldFollowMouseFocus({ ...base, hoveredPaneId: 1 })).toBe(false)
  })

  it('blocks while the primary mouse button is held (buttons=1)', () => {
    expect(shouldFollowMouseFocus({ ...base, mouseButtons: 1 })).toBe(false)
  })

  it('blocks while the secondary mouse button is held (buttons=2)', () => {
    expect(shouldFollowMouseFocus({ ...base, mouseButtons: 2 })).toBe(false)
  })

  it('blocks while multiple buttons are held (buttons=3)', () => {
    expect(shouldFollowMouseFocus({ ...base, mouseButtons: 3 })).toBe(false)
  })

  it('blocks when the window does not have OS focus', () => {
    expect(shouldFollowMouseFocus({ ...base, windowHasFocus: false })).toBe(false)
  })

  // Defensive case: createInitialPane always sets activePaneId before any
  // mouse events are possible in production, but the gate must still behave
  // correctly if the state ever occurs (e.g. future refactor of init flow).
  it('switches when activePaneId is null (defensive)', () => {
    expect(shouldFollowMouseFocus({ ...base, activePaneId: null })).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test file to confirm it fails**

Run: `pnpm exec vitest run src/renderer/src/lib/pane-manager/focus-follows-mouse.test.ts`
Expected: FAIL with an error resolving `./focus-follows-mouse` (the implementation file doesn't exist yet).

- [ ] **Step 3: Create the implementation file**

Create `src/renderer/src/lib/pane-manager/focus-follows-mouse.ts` with the following contents:

```ts
/**
 * Pure decision logic for the focus-follows-mouse feature. Kept free of
 * DOM/event dependencies so it can be unit-tested under vitest's node env.
 *
 * See docs/focus-follows-mouse-design.md for rationale behind each gate.
 */

export type FocusFollowsMouseInput = {
  featureEnabled: boolean
  activePaneId: number | null
  hoveredPaneId: number
  mouseButtons: number // MouseEvent.buttons bitmask
  windowHasFocus: boolean // document.hasFocus()
  managerDestroyed: boolean
}

/** Returns true iff the hovered pane should be activated. */
export function shouldFollowMouseFocus(input: FocusFollowsMouseInput): boolean {
  if (!input.featureEnabled) return false
  if (input.managerDestroyed) return false
  if (input.activePaneId === input.hoveredPaneId) return false
  // Why event.buttons !== 0: any held mouse button means a selection or
  // a drag is in progress. Switching focus mid-drag would break xterm.js
  // text selection and the pane drag-to-reorder flow. This single check
  // also covers drag-to-reorder, since the drag is always button-held.
  // See pane-drag-reorder.ts:77-103 for the drag state lifecycle.
  if (input.mouseButtons !== 0) return false
  // Why document.hasFocus: if Orca isn't the OS-focused window, the mouse
  // event is from the user passing through on their way to another app.
  // Also returns false when DevTools is focused (DevTools runs in a
  // separate WebContents) — accepted. Users close DevTools or click to
  // resume normal behavior.
  if (!input.windowHasFocus) return false
  return true
}
```

- [ ] **Step 4: Run the test file again to confirm all tests pass**

Run: `pnpm exec vitest run src/renderer/src/lib/pane-manager/focus-follows-mouse.test.ts`
Expected: PASS — 9 tests passing, 0 failing.

- [ ] **Step 5: Run the full test suite to confirm nothing else broke**

Run: `pnpm run test`
Expected: All pre-existing tests still pass, plus the 9 new ones.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/lib/pane-manager/focus-follows-mouse.ts src/renderer/src/lib/pane-manager/focus-follows-mouse.test.ts
git commit -m "feat: add pure shouldFollowMouseFocus gate helper"
```

---

## Task 4: Wire the `mouseenter` listener through `createPaneDOM` and `PaneManager`

**Files:**

- Modify: `src/renderer/src/lib/pane-manager/pane-lifecycle.ts` (update `createPaneDOM` signature around line 23-29, attach listener around line 126)
- Modify: `src/renderer/src/lib/pane-manager/pane-manager.ts` (add import around line 28, update `createPaneInternal` around line 287, add `handlePaneMouseEnter` after it)

Both files must be updated in the same commit: `createPaneDOM` gains a required parameter that its sole caller (`createPaneInternal`) must provide, so partial landings break the build.

- [ ] **Step 1: Add the `onMouseEnter` parameter to `createPaneDOM`**

Edit `src/renderer/src/lib/pane-manager/pane-lifecycle.ts`. Find the `createPaneDOM` function signature (around line 23-29) and update it:

```ts
export function createPaneDOM(
  id: number,
  options: PaneManagerOptions,
  dragState: DragReorderState,
  dragCallbacks: DragReorderCallbacks,
  onPointerDown: (id: number) => void,
  onMouseEnter: (id: number, event: MouseEvent) => void
): ManagedPaneInternal {
```

- [ ] **Step 2: Attach the `mouseenter` listener next to the existing `pointerdown` listener**

In the same file, find the existing `pointerdown` listener (around line 126):

```ts
// Focus handler: clicking a pane makes it active and explicitly focuses
// the terminal. We must call focus: true here because after DOM reparenting
// (e.g. splitPane moves the original pane into a flex container), xterm.js's
// native click-to-focus on its internal textarea may not fire reliably.
container.addEventListener('pointerdown', () => {
  onPointerDown(id)
})

return pane
```

Replace it with:

```ts
// Focus handler: clicking a pane makes it active and explicitly focuses
// the terminal. We must call focus: true here because after DOM reparenting
// (e.g. splitPane moves the original pane into a flex container), xterm.js's
// native click-to-focus on its internal textarea may not fire reliably.
container.addEventListener('pointerdown', () => {
  onPointerDown(id)
})

// Focus-follows-mouse handler: when the setting is enabled, hovering a
// pane makes it active. All gating (feature flag, drag-in-progress,
// window focus, etc.) lives in the PaneManager callback — this layer
// just forwards the event.
container.addEventListener('mouseenter', (event) => {
  onMouseEnter(id, event)
})

return pane
```

- [ ] **Step 3: Import the gate helper in `pane-manager.ts`**

Edit `src/renderer/src/lib/pane-manager/pane-manager.ts`. Find the existing imports (around line 20-28) and add a new import immediately after the existing pane-manager-related imports:

```ts
import { createPaneDOM, openTerminal, attachWebgl, disposePane } from './pane-lifecycle'
import { shouldFollowMouseFocus } from './focus-follows-mouse'
import {
  findPaneChildren,
  removeDividers,
  promoteSibling,
  wrapInSplit,
  safeFit,
  refitPanesUnder
} from './pane-tree-ops'
```

- [ ] **Step 4: Pass the new callback from `createPaneInternal`**

In the same file, find the `createPaneInternal` method (around line 287-302):

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
      }
    )
    this.panes.set(id, pane)
    return pane
  }
```

Replace it with:

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

  /**
   * Focus-follows-mouse entry point. Collects gate inputs from the manager
   * and delegates to the pure gate helper.
   *
   * Invariant for future contributors: modal overlays (context menus, close
   * dialogs, command palette) must be rendered as portals/siblings OUTSIDE
   * the pane container. If a future overlay is ever rendered inside a .pane
   * element, mouseenter will still fire on the pane underneath and this
   * handler will incorrectly switch focus. Keep overlays out of the pane.
   */
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

- [ ] **Step 5: Run typecheck to verify both files**

Run: `pnpm run tc:web`
Expected: Pass. If it fails with "Expected 6 arguments, but got 5" at `createPaneDOM`, you forgot to update the caller in `createPaneInternal`.

- [ ] **Step 6: Run the full test suite**

Run: `pnpm run test`
Expected: All tests pass, including the 9 from Task 3.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/lib/pane-manager/pane-lifecycle.ts src/renderer/src/lib/pane-manager/pane-manager.ts
git commit -m "feat: wire mouseenter listener through PaneManager for focus-follows-mouse"
```

---

## Task 5: Thread the setting through `resolvePaneStyleOptions` and `applyTerminalAppearance`

**Files:**

- Modify: `src/renderer/src/lib/terminal-theme.ts` (around line 103-120)
- Modify: `src/renderer/src/components/terminal-pane/terminal-appearance.ts` (around line 48-55)

At this point the gate helper reads `this.styleOptions.focusFollowsMouse`, which is always `undefined` because nothing populates it yet. This task plumbs the user setting into the runtime options bag.

- [ ] **Step 1: Extend `resolvePaneStyleOptions` to accept and pass the boolean**

**Callers of `resolvePaneStyleOptions`** (verified via grep — there are two, both pass a full `GlobalSettings` so widening the `Pick` union is non-breaking):

1. `src/renderer/src/components/terminal-pane/terminal-appearance.ts:21` — the runtime call from `applyTerminalAppearance`. You WILL modify this file in Step 2.
2. `src/renderer/src/components/settings/TerminalPane.tsx:68` — the settings-pane preview call that powers the theme preview. You will NOT need to modify this file in this task (it passes full `GlobalSettings`, which will contain `terminalFocusFollowsMouse` after Task 1). The new field will silently appear in the returned object and be ignored by the preview — that's fine.

Edit `src/renderer/src/lib/terminal-theme.ts`. Find the `resolvePaneStyleOptions` function (lines 103-118). The current full body is:

```ts
export function resolvePaneStyleOptions(
  settings: Pick<
    GlobalSettings,
    | 'terminalInactivePaneOpacity'
    | 'terminalActivePaneOpacity'
    | 'terminalPaneOpacityTransitionMs'
    | 'terminalDividerThicknessPx'
  >
) {
  return {
    inactivePaneOpacity: clampNumber(settings.terminalInactivePaneOpacity, 0, 1),
    activePaneOpacity: clampNumber(settings.terminalActivePaneOpacity, 0, 1),
    opacityTransitionMs: clampNumber(settings.terminalPaneOpacityTransitionMs, 0, 5000),
    dividerThicknessPx: clampNumber(settings.terminalDividerThicknessPx, 1, 32)
  }
}
```

Replace it with:

```ts
export function resolvePaneStyleOptions(
  settings: Pick<
    GlobalSettings,
    | 'terminalInactivePaneOpacity'
    | 'terminalActivePaneOpacity'
    | 'terminalPaneOpacityTransitionMs'
    | 'terminalDividerThicknessPx'
    | 'terminalFocusFollowsMouse'
  >
) {
  return {
    inactivePaneOpacity: clampNumber(settings.terminalInactivePaneOpacity, 0, 1),
    activePaneOpacity: clampNumber(settings.terminalActivePaneOpacity, 0, 1),
    opacityTransitionMs: clampNumber(settings.terminalPaneOpacityTransitionMs, 0, 5000),
    dividerThicknessPx: clampNumber(settings.terminalDividerThicknessPx, 1, 32),
    // Why no clamping: boolean pass-through. Both true and false are valid.
    focusFollowsMouse: settings.terminalFocusFollowsMouse
  }
}
```

- [ ] **Step 2: Pass `focusFollowsMouse` to `setPaneStyleOptions` in `applyTerminalAppearance`**

Edit `src/renderer/src/components/terminal-pane/terminal-appearance.ts`. Find the `setPaneStyleOptions` call (around line 48-55):

```ts
manager.setPaneStyleOptions({
  splitBackground: paneBackground,
  paneBackground,
  inactivePaneOpacity: paneStyles.inactivePaneOpacity,
  activePaneOpacity: paneStyles.activePaneOpacity,
  opacityTransitionMs: paneStyles.opacityTransitionMs,
  dividerThicknessPx: paneStyles.dividerThicknessPx
})
```

Replace it with:

```ts
manager.setPaneStyleOptions({
  splitBackground: paneBackground,
  paneBackground,
  inactivePaneOpacity: paneStyles.inactivePaneOpacity,
  activePaneOpacity: paneStyles.activePaneOpacity,
  opacityTransitionMs: paneStyles.opacityTransitionMs,
  dividerThicknessPx: paneStyles.dividerThicknessPx,
  focusFollowsMouse: paneStyles.focusFollowsMouse
})
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm run tc:web`
Expected: Pass. If it fails saying `paneStyles.focusFollowsMouse` is not assignable (e.g. `undefined` vs `boolean`), double-check that Step 1 added the field to `resolvePaneStyleOptions`'s returned object.

- [ ] **Step 4: Run the full test suite**

Run: `pnpm run test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/terminal-theme.ts src/renderer/src/components/terminal-pane/terminal-appearance.ts
git commit -m "feat: thread focusFollowsMouse through pane-style pipeline"
```

**At this point the feature is functionally complete internally.** If a developer manually flipped `terminalFocusFollowsMouse: true` in the persisted settings file, it would work. Tasks 6 and 7 add the discoverable user-facing surface.

---

## Task 6: Add the settings toggle UI in TerminalPane.tsx

**Files:**

- Modify: `src/renderer/src/components/settings/TerminalPane.tsx` (disable comment at line 1; toggle insertion around line 290, the closing of the Pane Styling grid)

**⚠️ Line-count constraint:** `TerminalPane.tsx` is currently exactly 400 lines total (and oxlint passes, so effective non-blank/non-comment lines are ≤ 400). The project's `.oxlintrc.json` sets `max-lines: 400` for `.tsx` files (line 71). Adding the new toggle (~33 lines) would push the file over the limit and the commit in Step 3 would fail under the lint-staged `oxlint` pre-commit hook.

**The project's established workaround** is a file-scoped `eslint-disable` comment with justification — see `src/renderer/src/components/settings/GeneralPane.tsx:1-3`, which does the same for the same reason (484 lines, all owning general settings UI). Step 1 below applies this pattern to `TerminalPane.tsx` _before_ adding the toggle, so the file never goes over the limit.

- [ ] **Step 1: Add the `max-lines` eslint-disable at the top of TerminalPane.tsx**

Edit `src/renderer/src/components/settings/TerminalPane.tsx`. The file currently starts with:

```tsx
import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
```

Prepend a file-level disable comment with an explicit justification (matching the `GeneralPane.tsx` precedent):

```tsx
/* eslint-disable max-lines -- Why: TerminalPane is the single owner of all terminal settings UI;
   splitting individual settings into separate files would scatter related controls without a
   meaningful abstraction boundary. Mirrors the same decision made for GeneralPane.tsx. */
import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
```

- [ ] **Step 2: Add the `SearchableSetting` toggle below the Pane Styling grid**

Edit `src/renderer/src/components/settings/TerminalPane.tsx`. Find the end of the Pane Styling grid (around line 290):

```tsx
          <SearchableSetting
            title="Divider Thickness"
            description="Thickness of the pane divider line."
            keywords={['pane', 'divider', 'thickness']}
          >
            <NumberField
              label="Divider Thickness"
              description="Thickness of the pane divider line."
              value={paneStyleOptions.dividerThicknessPx}
              defaultValue={1}
              min={1}
              max={32}
              step={1}
              suffix="px"
              onChange={(value) =>
                updateSettings({
                  terminalDividerThicknessPx: clampNumber(value, 1, 32)
                })
              }
            />
          </SearchableSetting>
        </div>
      </section>
```

Insert a new `SearchableSetting` toggle between the closing `</div>` of the grid and the closing `</section>`:

```tsx
          <SearchableSetting
            title="Divider Thickness"
            description="Thickness of the pane divider line."
            keywords={['pane', 'divider', 'thickness']}
          >
            <NumberField
              label="Divider Thickness"
              description="Thickness of the pane divider line."
              value={paneStyleOptions.dividerThicknessPx}
              defaultValue={1}
              min={1}
              max={32}
              step={1}
              suffix="px"
              onChange={(value) =>
                updateSettings({
                  terminalDividerThicknessPx: clampNumber(value, 1, 32)
                })
              }
            />
          </SearchableSetting>
        </div>

        <SearchableSetting
          title="Focus Follows Mouse"
          description="Hovering a terminal pane activates it without needing to click. Mirrors Ghostty's focus-follows-mouse setting."
          keywords={['focus', 'follows', 'mouse', 'hover', 'pane', 'ghostty', 'active']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Focus Follows Mouse</Label>
            <p className="text-xs text-muted-foreground">
              Hovering a terminal pane activates it without needing to click.
              Mirrors Ghostty&apos;s focus-follows-mouse setting. Selections and
              window switching stay safe.
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
      </section>
```

**Placement rationale:** The new toggle sits _below_ the existing 2-column `grid` (not inside it) because a full-width toggle row doesn't balance well next to numeric input fields in a 2-column layout.

- [ ] **Step 3: Run typecheck and lint**

Run: `pnpm run tc:web && pnpm exec oxlint src/renderer/src/components/settings/TerminalPane.tsx`
Expected: Both pass with 0 errors. The explicit `oxlint` run is a safety net: if the file somehow still trips `max-lines` (e.g., the disable comment was formatted incorrectly), catch it here rather than in the pre-commit hook.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/settings/TerminalPane.tsx
git commit -m "feat: add Focus Follows Mouse toggle to Terminal settings"
```

---

## Task 7: Add the settings search entry

**Files:**

- Modify: `src/renderer/src/components/settings/terminal-search.ts` (around line 34-45, the `TERMINAL_PANE_STYLE_SEARCH_ENTRIES` array)

- [ ] **Step 1: Add the new entry to `TERMINAL_PANE_STYLE_SEARCH_ENTRIES`**

Edit `src/renderer/src/components/settings/terminal-search.ts`. Find `TERMINAL_PANE_STYLE_SEARCH_ENTRIES` (around line 34):

```ts
export const TERMINAL_PANE_STYLE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Inactive Pane Opacity',
    description: 'Opacity applied to panes that are not currently active.',
    keywords: ['pane', 'opacity', 'dimming']
  },
  {
    title: 'Divider Thickness',
    description: 'Thickness of the pane divider line.',
    keywords: ['pane', 'divider', 'thickness']
  }
]
```

Replace it with:

```ts
export const TERMINAL_PANE_STYLE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Inactive Pane Opacity',
    description: 'Opacity applied to panes that are not currently active.',
    keywords: ['pane', 'opacity', 'dimming']
  },
  {
    title: 'Divider Thickness',
    description: 'Thickness of the pane divider line.',
    keywords: ['pane', 'divider', 'thickness']
  },
  {
    title: 'Focus Follows Mouse',
    description: 'Hovering a terminal pane activates it without needing to click.',
    keywords: ['focus', 'follows', 'mouse', 'hover', 'pane', 'ghostty', 'active']
  }
]
```

**Note:** No changes needed to `TERMINAL_PANE_SEARCH_ENTRIES` (the aggregator at line 86) because it spreads `TERMINAL_PANE_STYLE_SEARCH_ENTRIES` automatically.

- [ ] **Step 2: Run typecheck and tests**

Run: `pnpm run tc:web && pnpm run test`
Expected: Both pass.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/terminal-search.ts
git commit -m "feat: add Focus Follows Mouse to settings search index"
```

---

## Task 8: Manual smoke test verification

This task does not produce a commit. It verifies the feature end-to-end in a running build and catches any issue that couldn't be caught by typecheck or unit tests (DOM event interactions, xterm.js behavior, Electron window focus, visual correctness).

- [ ] **Step 1: Launch the app in dev mode**

Run: `pnpm run dev`
Expected: Orca opens. Wait for it to fully initialize (worktree list populates).

- [ ] **Step 2: Enable the setting**

Open Settings (gear icon or menu) → Terminal → Pane Styling. Find the "Focus Follows Mouse" toggle. Toggle it ON.

Expected: The toggle visibly flips to the on state (dark background, white dot on the right).

- [ ] **Step 3: Restart the app and verify persistence**

Close Orca. Run `pnpm run dev` again. Open Settings → Terminal → Pane Styling.

Expected: The toggle is still ON (the setting persisted to the JSON state file).

- [ ] **Step 4: Verify multi-split hover activation**

Open a worktree with a terminal. Create at least 2 splits (use the split-pane UI or keyboard shortcut). Click on pane A to make it active. Move the mouse over pane B without clicking.

Expected: Pane B's opacity updates to the active value, pane B's cursor starts blinking, and typing on the keyboard routes to pane B's shell.

- [ ] **Step 5: Verify text selection is not broken mid-drag**

In a single pane, click-drag to select text. Start the drag in pane A and continue dragging the selection into pane B.

Expected: The text selection extends normally. Focus does NOT switch from pane A to pane B during the drag. When you release the mouse button, the selection is finalized in pane A. (If focus switches mid-drag, the `mouseButtons !== 0` gate is broken.)

- [ ] **Step 6: Verify pane drag-to-reorder is not broken**

Hover a pane so the drag handle (the top strip) appears. Click-drag the pane by its drag handle to a drop zone.

Expected: The drag animation completes normally. No focus flicker during the drag.

- [ ] **Step 7: Verify window-focus gating with Cmd-Tab**

With 2+ splits and the setting enabled: click pane A to make it active. Cmd-Tab to another app. Move the mouse over pane B (still visible). Cmd-Tab back to Orca.

Expected: Pane A (the previously-active pane) is still active — focus did NOT switch to pane B just because the mouse was over it when Orca regained focus.

- [ ] **Step 8: Verify DevTools focus pauses the feature**

With 2+ splits, open Orca DevTools (View → Toggle Developer Tools, or Cmd-Opt-I). Click inside the DevTools panel to focus it. Move the mouse over an inactive pane.

Expected: Focus does NOT switch. `document.hasFocus()` returns false while DevTools is focused, so the gate blocks. Close DevTools, wiggle the mouse → focus-follows-mouse resumes on the next `mouseenter`.

- [ ] **Step 9: Verify modal overlay safety**

With 2+ splits, open the close-terminal confirmation dialog (Cmd-W or the close button on a pane). While the confirmation dialog is visible, move the mouse over a different pane.

Expected: Focus does NOT switch. The modal portal sits above the pane DOM, so `mouseenter` on the pane never fires while the modal is open.

- [ ] **Step 10: Verify URL hover tooltip still works**

With the setting ON, hover a URL in an inactive pane (run `echo https://example.com` in one pane, then hover that URL from another pane).

Expected: (1) The pane activates via focus-follows-mouse. (2) The `Cmd+click to open` URL tooltip appears in the bottom-left of the newly-activated pane. (If the tooltip fails to appear or flickers, there's an interaction issue between `setActivePane → terminal.focus()` and xterm.js's `WebLinksAddon` hover tracking — worth filing and debugging separately.)

- [ ] **Step 11: Verify disabling the setting stops the behavior**

Toggle the setting OFF in Settings. Return to the terminal view. Hover an inactive pane.

Expected: Focus does NOT switch on hover. Click on the pane — the click still activates it. (Disabling the feature must not regress click-to-focus.)

- [ ] **Step 12: Verify single-pane layout has no regressions**

Close all splits so only one pane remains. Toggle the setting ON. Hover the pane.

Expected: No crash, no console errors. The single pane stays focused. (The `activePaneId === hoveredPaneId` gate makes this a no-op.)

- [ ] **Step 13: Verify three-pane traversal flicker (informational)**

Create a horizontal layout of 3 panes: A | B | C. Click pane A. Move the mouse quickly from A straight to C.

Expected: A brief flicker of activation on B as the mouse traverses it (this is the accepted cost of Ghostty-parity immediate switching, documented in the spec). Confirm the flicker is tolerable. If it feels bad, the spec has a follow-up plan for adding a settle delay.

- [ ] **Step 14: Mark the plan complete**

If all 13 checks above passed, the feature is complete. The PR description should embed this smoke test checklist for the reviewer to verify.

---

## Verification Summary

After all 8 tasks are complete, the final state should be:

- 7 new commits on the branch (one per task, Task 8 is verify-only).
- 9 new unit tests passing (`focus-follows-mouse.test.ts`).
- Full typecheck passes (`pnpm run tc`).
- Full test suite passes (`pnpm run test`).
- Manual smoke test checklist (Task 8 Steps 1-13) passes in `pnpm run dev`.
- The setting is discoverable via Settings → Terminal → Pane Styling AND via the settings search box (queries: "focus", "follows", "mouse", "hover", "ghostty").
- The setting defaults to **off** for both new and upgrading users.
