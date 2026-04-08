# Cmd+Number Worktree Switching — Design Document

## Problem

Switching between worktrees currently requires clicking the sidebar or using Cmd+Shift+Arrow to step through them one at a time. Power users managing many worktrees need a faster way to jump directly to a specific worktree — similar to how browsers support Cmd+1–9 for tab switching.

## Feature Overview

1. **Cmd+1–9**: Instantly switch to the Nth visible worktree in the sidebar. Fires on `keydown` with zero delay — the user does not need to wait for the hint overlay.
2. **Cmd hold hint overlay**: After holding Cmd for 1 second, show number badges (1–9) on the first 9 visible worktree cards so the user knows which number maps to which worktree.

These are **independent mechanisms**. The shortcut works instantly regardless of whether the hint overlay is visible. A user who already knows the worktree numbers never waits for anything; the overlay exists purely for discoverability.

## Design

### 1. Cmd+1–9 Shortcut (Instant Switch)

**Where**: `App.tsx` keydown handler (the existing capture-phase listener at line ~388). The handler must be placed **before the `isEditableTarget` guard** — the same position used by Cmd+P. This is critical: the `isEditableTarget` early return blocks shortcuts when focus is in inputs, textareas, or contentEditable elements (e.g., sidebar search input, Monaco editor, rich markdown editor). Placing the handler after this guard would break the "works regardless of focus" requirement.

**Behavior**:

- On `keydown` with `mod` (Cmd on macOS, Ctrl on Linux/Windows) + a digit key `1`–`9`, switch to the Nth visible worktree. This fires **instantly** — no timer, no delay. The 1-second delay described in Section 2 applies only to the hint overlay and has no effect on shortcut responsiveness.
- "Visible worktrees" means the filtered, sorted, non-archived worktree list. This already accounts for search filters, repo filters, and sort order.
- `Cmd+1` activates the 1st worktree, `Cmd+9` activates the 9th. If there are fewer than N worktrees, the shortcut is a no-op.
- After switching, scroll the sidebar to reveal the activated card (same `scrollToIndex` pattern used by `navigateWorktree`).

#### Collapsed Groups

Numbering counts **all non-filtered, non-archived worktrees** regardless of whether their containing group is collapsed in the sidebar UI. The `getVisibleWorktreeIds()` selector does not need access to `collapsedGroups` state — it derives the ordered list purely from worktree data, sort order, and filters.

This means badge numbers on visible cards may not match their visual position if groups above them are collapsed (e.g., if a collapsed group contains worktrees 2–4, the first card the user actually sees might be badge 5). This is **accepted behavior**. Why: numbering needs to be stable regardless of collapse state — if collapsing a group renumbered everything below it, the mapping would shift unpredictably as users expand and collapse groups, making the shortcut less reliable.

#### Sort Stability

Under smart sort, worktree ordering can change automatically as activity shifts (agent finishes, terminal spawns, editor opens, etc.), so Cmd+3 may target a different worktree than it did 10 minutes ago. This is **accepted behavior** for two reasons:

1. **Top positions tend to be stable.** The highest-scoring worktrees under smart sort are typically the ones the user is actively working in, so Cmd+1 and Cmd+2 rarely drift mid-session.
2. **Users who want fully stable numbering can use name sort**, which produces a deterministic alphabetical order that never changes unless worktrees are created or deleted.

**Why App.tsx and not WorktreeList.tsx**: The shortcut should work regardless of focus — whether the user is in the terminal, editor, or sidebar. App-level capture-phase handlers already own this responsibility for Cmd+N, Cmd+B, Cmd+P, etc. Note that Cmd+P is the precedent for the required placement: it is explicitly placed before the `isEditableTarget` guard with a comment explaining why. Cmd+1–9 must follow the same pattern.

**Accessing worktree order from App.tsx**: The App-level handler needs access to the ordered visible worktree list, which is currently computed inside `WorktreeList`. Two options:

- **Option A — Store-derived selector**: Create a Zustand selector that computes the visible worktree order (reusing the same sort/filter logic). App.tsx reads `visibleWorktreeIds` from the store. This is the cleanest option since the sort order is already derived from store state.
- **Option B — Ref/callback bridge**: WorktreeList exposes the current ordered worktree IDs via a ref or callback that App.tsx can read. This avoids duplicating sort logic but introduces coupling between the components.

**Recommendation**: Option A. The sort/filter logic should be a pure function of store state anyway, and extracting it into a shared selector or utility that both `WorktreeList` and the App-level handler consume avoids duplication.

**Preventing selector drift**: Today `WorktreeList` computes its own `visibleWorktrees` memo inline. If we also create a `getVisibleWorktreeIds()` store selector, the two pipelines could diverge over time (e.g., a new filter added in one place but not the other). To prevent this, the filtering and sorting pipeline should be extracted into a **shared pure utility function** — something like `computeVisibleWorktreeIds(worktrees, sortBy, filters, searchQuery)` — that both the Zustand selector and `WorktreeList`'s render logic consume. This makes drift a compile-time error (change the function signature → both call sites must update) rather than a silent runtime bug.

**Implementation sketch** (App.tsx keydown handler — place BEFORE the `isEditableTarget` guard, right after the Cmd+P block):

```typescript
// Why: Cmd+1–9 must be handled before the isEditableTarget guard so the
// shortcut fires from any focus context — including sidebar search input,
// Monaco editor, and contentEditable elements. This follows the same
// pattern as Cmd+P above.
if (mod && !e.altKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
  const index = parseInt(e.key, 10) - 1
  const visibleIds = getVisibleWorktreeIds() // from store selector
  if (index < visibleIds.length) {
    // Prevent the digit from being typed into the focused input/editor
    e.preventDefault()
    setActiveWorktree(visibleIds[index])
  }
  return
}
```

### 2. Cmd Hold Hint Overlay (1-Second Delay)

**Where**: New state + effect in `WorktreeList.tsx` (or a dedicated `useModifierHint` hook), rendered as badge overlays on `WorktreeCard`.

**Behavior**:

- Track `keydown`/`keyup` for the Meta key (Mac) or Control key (Linux/Windows).
- On `keydown` of the modifier (alone, no other keys pressed), start a 1-second timer.
- If the modifier is still held after 1 second and no other key was pressed during that time, set `showNumberHints = true`.
- On `keyup` of the modifier, clear the timer and set `showNumberHints = false`.
- If any other key is pressed while the modifier is held (e.g., the user does Cmd+N), cancel the timer and never show the hints — the user is executing a shortcut, not looking for help.

**Rendering the badges**:

- When `showNumberHints` is true, the first 9 visible worktree cards each display a small number badge (1–9).
- Badge position: top-left corner of the card, overlapping the status indicator area. Use absolute positioning within the card's `relative` container.
- Badge style: small rounded pill, e.g. `bg-foreground text-background text-[10px] font-semibold w-4 h-4 flex items-center justify-center rounded shadow-sm`. Should feel like a keyboard hint, not a notification.
- Animate in with a subtle `fade-in` + `scale-in` (matching the existing tooltip animation style).
- Animate out immediately on keyup (no fade-out delay — hints should vanish instantly when the modifier is released).

**Why a dedicated hook**: The modifier-hold detection (keydown timer + keyup cancel + other-key cancel) is self-contained logic that benefits from isolation. A `useModifierHint` hook returns `{ showHints: boolean }` and can be consumed by WorktreeList without polluting the component body.

**Discoverability note**: The 1-second Cmd-hold interaction is a non-standard pattern — most users won't discover it accidentally. The overlay serves users who are already holding Cmd while thinking about which worktree to switch to, but it shouldn't be the _only_ path to learning the shortcuts exist. The Cmd+1–9 binding should also be listed in any future keyboard shortcuts settings pane or help dialog (see Section 5, Accessibility) so that users who look for shortcuts through conventional UI can find it.

**Edge cases**:

- **Window blur**: If the user Cmd+Tabs away, the `keyup` event may never fire. Listen to `window.blur` to reset the state.
- **Repeat events**: `keydown` fires repeatedly when held. The timer should only start on the first press (`e.repeat === false`).
- **Sidebar hidden**: If the left sidebar is collapsed, don't show hints (no visible cards to badge). The shortcut itself should still work.
- **Fewer than 9 worktrees**: Only show badges for worktrees that exist. If there are 4 worktrees, show badges 1–4.

**Implementation sketch** (hook):

```typescript
function useModifierHint(): { showHints: boolean } {
  const [showHints, setShowHints] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const modKey = navigator.userAgent.includes('Mac') ? 'Meta' : 'Control'

    const clear = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setShowHints(false)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return

      // If the modifier key itself was pressed (not as part of a combo)
      if (e.key === modKey && !e.altKey && !e.shiftKey) {
        if (!timerRef.current) {
          timerRef.current = setTimeout(() => setShowHints(true), 1000)
        }
        return
      }

      // Any other key while modifier is held → cancel hint timer
      clear()
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === modKey) clear()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', clear)

    return () => {
      clear()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', clear)
    }
  }, [])

  return { showHints }
}
```

**Badge rendering** (WorktreeCard):

```tsx
// Passed as a prop: hintNumber?: number (1-9, or undefined if no hint)
{
  hintNumber && (
    <div className="absolute -left-1 -top-1 z-20 flex h-4 w-4 items-center justify-center rounded bg-foreground text-[10px] font-semibold text-background shadow-sm animate-in fade-in zoom-in-75 duration-150">
      {hintNumber}
    </div>
  )
}
```

### 3. Data Flow & System Context

```
┌─────────────────────────────────────────────────────────────┐
│                      Zustand Store                          │
│  worktreesByRepo, sortBy, filters, searchQuery, archived    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
          ┌────────────────────────────────┐
          │ computeVisibleWorktreeIds()    │  ← shared pure utility
          │ (sort + filter + search)       │    (single source of truth)
          └───────────────┬────────────────┘
                          │
             ┌────────────┴────────────┐
             │                         │
             ▼                         ▼
  ┌─────────────────────┐   ┌──────────────────────────┐
  │ getVisibleWorktree  │   │ WorktreeList.tsx          │
  │ Ids() — Zustand     │   │ uses same utility for    │
  │ selector            │   │ rendering worktree cards  │
  └─────────┬───────────┘   └──────────┬───────────────┘
            │                          │
            ▼                          ▼
  ┌─────────────────────┐   ┌──────────────────────────┐
  │ App.tsx              │   │ useModifierHint() hook   │
  │ keydown handler      │   │ (tracks Cmd hold state)  │
  │ Cmd+1–9 fires       │   └──────────┬───────────────┘
  │ setActiveWorktree()  │              │
  └──────────────────────┘              ▼
                           ┌──────────────────────────┐
                           │ WorktreeCard             │
                           │ hintNumber={index + 1}   │
                           │ for first 9 cards        │
                           └──────────────────────────┘
```

The **critical invariant** is that both consumers — the App-level keydown handler and WorktreeList's card rendering — derive worktree order from the same `computeVisibleWorktreeIds()` utility. This guarantees that pressing Cmd+3 always activates the worktree whose card displays badge "3".

### 4. Conflict Check

Existing shortcuts that could conflict with Cmd+1–9:

| Shortcut      | Current binding                | Conflict?          |
| ------------- | ------------------------------ | ------------------ |
| Cmd+0         | Focus sidebar scroll container | No (0 is excluded) |
| Cmd+= / Cmd+- | Zoom in/out                    | No                 |
| Cmd+1–9       | _None currently bound_         | Safe to use        |

Electron's default menu does not bind Cmd+1–9 on macOS. No conflicts expected.

### 5. Accessibility

- The number badges are decorative hints (not interactive), so they should have `aria-hidden="true"`.
- The shortcut itself is a keyboard navigation enhancement, which improves accessibility.
- The shortcut should be listed in any future "Keyboard Shortcuts" settings pane or help dialog. Because the Cmd-hold hint overlay is a non-standard interaction pattern, conventional discoverability through a shortcuts reference is important as a secondary path.

### 6. Rollout

This feature can ship in a single PR with no feature flag — it's purely additive, introduces no new IPC, and doesn't modify existing data models. The shortcut is discoverable via the hold-to-reveal hint, so no onboarding UI is needed.
