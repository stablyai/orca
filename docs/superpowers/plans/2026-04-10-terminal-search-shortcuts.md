# Terminal Search Next/Previous Shortcuts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Cmd+G` / `Cmd+Shift+G` shortcuts to navigate terminal search matches when the search bar is open.

**Architecture:** A `searchStateRef` bridges the search query/options from `TerminalSearch` (which owns the state) to `keyboard-handlers.ts` (which handles the shortcut). The `Cmd+G` handler is placed before the `isEditableTarget` guard so it works even when focus is in the search input.

**Tech Stack:** React, TypeScript, xterm.js (`@xterm/addon-search`), Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/renderer/src/components/terminal-pane/keyboard-handlers.ts` | Modify | Add `Cmd+G` / `Cmd+Shift+G` handler |
| `src/renderer/src/components/TerminalSearch.tsx` | Modify | Accept and sync `searchStateRef` |
| `src/renderer/src/components/terminal-pane/TerminalPane.tsx` | Modify | Create and wire `searchStateRef` |
| `src/renderer/src/components/terminal-pane/keyboard-handlers.test.ts` | Create | Test the new shortcut handler logic |

---

### Task 1: Extract and test the `Cmd+G` / `Cmd+Shift+G` key-matching logic

The keyboard handler uses a capture-phase `window` listener with DOM dependencies (`e.target`, `pane.terminal.focus()`). Rather than mocking all of that, we test the **decision logic** in isolation: given a key event shape + search state, should the handler fire findNext, findPrevious, or do nothing?

**Files:**
- Create: `src/renderer/src/components/terminal-pane/keyboard-handlers.test.ts`

- [ ] **Step 1: Write failing tests for the search-navigate decision logic**

We'll test a pure helper function `matchSearchNavigate` that we'll extract in Task 2. For now, write the tests against the expected interface.

```ts
// src/renderer/src/components/terminal-pane/keyboard-handlers.test.ts
import { describe, it, expect } from 'vitest'
import { matchSearchNavigate } from './keyboard-handlers'

function makeKeyEvent(overrides: Partial<{
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}>): Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'> {
  return {
    key: 'g',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides
  }
}

describe('matchSearchNavigate', () => {
  const isMac = true
  const searchState = { query: 'hello', caseSensitive: false, regex: false }

  it('returns "next" for Cmd+G on macOS', () => {
    const e = makeKeyEvent({ metaKey: true })
    expect(matchSearchNavigate(e, isMac, true, searchState)).toBe('next')
  })

  it('returns "previous" for Cmd+Shift+G on macOS', () => {
    const e = makeKeyEvent({ metaKey: true, shiftKey: true })
    expect(matchSearchNavigate(e, isMac, true, searchState)).toBe('previous')
  })

  it('returns null when search is closed', () => {
    const e = makeKeyEvent({ metaKey: true })
    expect(matchSearchNavigate(e, isMac, false, searchState)).toBeNull()
  })

  it('returns null when query is empty', () => {
    const e = makeKeyEvent({ metaKey: true })
    expect(matchSearchNavigate(e, isMac, true, { query: '', caseSensitive: false, regex: false })).toBeNull()
  })

  it('returns null for wrong key', () => {
    const e = makeKeyEvent({ metaKey: true, key: 'f' })
    expect(matchSearchNavigate(e, isMac, true, searchState)).toBeNull()
  })

  it('returns null when alt is pressed', () => {
    const e = makeKeyEvent({ metaKey: true, altKey: true })
    expect(matchSearchNavigate(e, isMac, true, searchState)).toBeNull()
  })

  it('returns "next" for Ctrl+G on Linux/Windows', () => {
    const e = makeKeyEvent({ ctrlKey: true })
    expect(matchSearchNavigate(e, false, true, searchState)).toBe('next')
  })

  it('returns null for Ctrl+G on macOS (wrong modifier)', () => {
    const e = makeKeyEvent({ ctrlKey: true })
    expect(matchSearchNavigate(e, true, true, searchState)).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/renderer/src/components/terminal-pane/keyboard-handlers.test.ts`
Expected: FAIL — `matchSearchNavigate` is not exported from `keyboard-handlers`

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/terminal-pane/keyboard-handlers.test.ts
git commit -m "test: add failing tests for search-navigate key matching"
```

---

### Task 2: Implement `matchSearchNavigate` and wire it into the keyboard handler

**Files:**
- Modify: `src/renderer/src/components/terminal-pane/keyboard-handlers.ts`

- [ ] **Step 1: Add the `SearchState` type and `matchSearchNavigate` function**

Add this above the `useTerminalKeyboardShortcuts` function:

```ts
export type SearchState = {
  query: string
  caseSensitive: boolean
  regex: boolean
}

/**
 * Pure decision function for Cmd+G / Cmd+Shift+G search navigation.
 * Returns 'next', 'previous', or null (no match).
 * Extracted so the key-matching logic is testable without DOM dependencies.
 */
export function matchSearchNavigate(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  isMac: boolean,
  searchOpen: boolean,
  searchState: SearchState
): 'next' | 'previous' | null {
  if (e.altKey) return null
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod) return null
  if (e.key.toLowerCase() !== 'g') return null
  if (!searchOpen) return null
  if (!searchState.query) return null
  return e.shiftKey ? 'previous' : 'next'
}
```

- [ ] **Step 2: Add `searchOpen` and `searchStateRef` to the deps type**

Update the `KeyboardHandlersDeps` type — add two new fields:

```ts
type KeyboardHandlersDeps = {
  isActive: boolean
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  expandedPaneIdRef: React.RefObject<number | null>
  setExpandedPane: (paneId: number | null) => void
  restoreExpandedLayout: () => void
  refreshPaneSizes: (focusActive: boolean) => void
  persistLayoutSnapshot: () => void
  toggleExpandPane: (paneId: number) => void
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>
  onRequestClosePane: (paneId: number) => void
  searchOpen: boolean
  searchStateRef: React.RefObject<SearchState>
}
```

- [ ] **Step 3: Add the `Cmd+G` handler inside `onKeyDown`, before the `isEditableTarget` guard**

Insert this block in `onKeyDown` right after the `if (e.repeat) return` check (line 62) and before `if (isEditableTarget(e.target))` (line 64):

```ts
      // Cmd+G / Cmd+Shift+G navigates terminal search matches.
      // Placed before the isEditableTarget guard so it works when focus
      // is in the search input. Uses its own mod-key check because this
      // runs before the shared `mod` variable is declared.
      // preventDefault suppresses macOS/Electron's native "find next".
      const direction = matchSearchNavigate(e, isMac, searchOpen, searchStateRef.current)
      if (direction !== null) {
        e.preventDefault()
        e.stopPropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) return
        const { query, caseSensitive, regex } = searchStateRef.current
        if (direction === 'next') {
          pane.searchAddon.findNext(query, { caseSensitive, regex })
        } else {
          pane.searchAddon.findPrevious(query, { caseSensitive, regex })
        }
        pane.terminal.focus()
        return
      }
```

Note: this block accesses `manager` which is declared further down. Move the `const manager = managerRef.current; if (!manager) return` check above the `isEditableTarget` guard as well, so the search handler can reference it. This reorder is safe — the code between the old `manager` position and `isEditableTarget` only computes `mod` and checks `altKey`, neither of which references `manager`. The minor behavioral change is that `!manager` now short-circuits before `isEditableTarget` runs, which is harmless (no manager means no terminal to handle shortcuts for). The full reordering inside `onKeyDown` becomes:

```
if (e.repeat) return
const manager = managerRef.current    // ← moved up from line 72
if (!manager) return                  // ← moved up from line 73
// Cmd+G / Cmd+Shift+G handler (new)
if (isEditableTarget(e.target)) return
const mod = ...
```

- [ ] **Step 4: Add `searchOpen` and `searchStateRef` to the destructuring and useEffect deps array**

Update the function signature destructuring to include `searchOpen` and `searchStateRef`. Add both to the `useEffect` dependency array (alongside the existing entries):

```ts
export function useTerminalKeyboardShortcuts({
  isActive,
  managerRef,
  paneTransportsRef,
  expandedPaneIdRef,
  setExpandedPane,
  restoreExpandedLayout,
  refreshPaneSizes,
  persistLayoutSnapshot,
  toggleExpandPane,
  setSearchOpen,
  onRequestClosePane,
  searchOpen,
  searchStateRef
}: KeyboardHandlersDeps): void {
  useEffect(() => {
    // ...
  }, [
    isActive,
    managerRef,
    paneTransportsRef,
    expandedPaneIdRef,
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    persistLayoutSnapshot,
    toggleExpandPane,
    setSearchOpen,
    onRequestClosePane,
    searchOpen,
    searchStateRef
  ])
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- src/renderer/src/components/terminal-pane/keyboard-handlers.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/terminal-pane/keyboard-handlers.ts src/renderer/src/components/terminal-pane/keyboard-handlers.test.ts
git commit -m "feat: add Cmd+G / Cmd+Shift+G search navigation to keyboard handler"
```

---

### Task 3: Wire `searchStateRef` through `TerminalPane`, `TerminalSearch`, and sync it

Tasks 3 modifies both `TerminalPane.tsx` and `TerminalSearch.tsx` together because `searchStateRef` is a required prop — modifying them separately would break TypeScript compilation between commits.

**Files:**
- Modify: `src/renderer/src/components/terminal-pane/TerminalPane.tsx`
- Modify: `src/renderer/src/components/TerminalSearch.tsx`

- [ ] **Step 1: Import `SearchState` and create the ref in `TerminalPane`**

Add the import at the top of `TerminalPane.tsx` alongside the existing `keyboard-handlers` import:

```ts
import { useTerminalKeyboardShortcuts } from './keyboard-handlers'
```

becomes:

```ts
import { useTerminalKeyboardShortcuts, type SearchState } from './keyboard-handlers'
```

Then add the ref near the other refs (after `const [searchOpen, setSearchOpen] = useState(false)` on line 65):

```ts
  const searchStateRef = useRef<SearchState>({ query: '', caseSensitive: false, regex: false })
```

- [ ] **Step 2: Pass `searchOpen` and `searchStateRef` to `useTerminalKeyboardShortcuts`**

Update the call (around line 263) to include the two new fields:

```ts
  useTerminalKeyboardShortcuts({
    isActive,
    managerRef,
    paneTransportsRef,
    expandedPaneIdRef,
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    persistLayoutSnapshot,
    toggleExpandPane,
    setSearchOpen,
    onRequestClosePane: handleRequestClosePane,
    searchOpen,
    searchStateRef
  })
```

- [ ] **Step 3: Pass `searchStateRef` to `TerminalSearch`**

Update the `TerminalSearch` JSX (around line 567) to include the new prop:

```tsx
          <TerminalSearch
            isOpen={searchOpen}
            onClose={() => setSearchOpen(false)}
            searchAddon={activePane.searchAddon ?? null}
            searchStateRef={searchStateRef}
          />,
```

- [ ] **Step 4: Add `searchStateRef` prop to `TerminalSearch`**

In `TerminalSearch.tsx`, update the props type and destructuring:

```ts
type TerminalSearchProps = {
  isOpen: boolean
  onClose: () => void
  searchAddon: SearchAddon | null
  searchStateRef: React.MutableRefObject<{ query: string; caseSensitive: boolean; regex: boolean }>
}

export default function TerminalSearch({
  isOpen,
  onClose,
  searchAddon,
  searchStateRef
}: TerminalSearchProps): React.JSX.Element | null {
```

- [ ] **Step 5: Sync the ref inside the existing incremental-search `useEffect`**

The existing `useEffect` (lines 47–55) already runs whenever `query`, `caseSensitive`, or `regex` change. Add the ref sync at the top, before the early return on empty query. This ensures the ref stays in sync even when the query is cleared (so it reflects the true current state):

```ts
  useEffect(() => {
    // Keep the ref in sync so the keyboard handler (Cmd+G / Cmd+Shift+G)
    // can read the current search state without lifting it to parent state.
    searchStateRef.current = { query, caseSensitive, regex }

    if (!query) {
      searchAddon?.clearDecorations()
      return
    }
    if (searchAddon && isOpen) {
      searchAddon.findNext(query, { caseSensitive, regex, incremental: true })
    }
  }, [query, searchAddon, isOpen, caseSensitive, regex, searchStateRef])
```

Note: `searchStateRef` is added to the dependency array to satisfy the linter, though as a ref it never changes identity.

- [ ] **Step 6: Run the full test suite to verify nothing is broken**

Run: `pnpm test`
Expected: All tests pass (no regressions)

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/terminal-pane/TerminalPane.tsx src/renderer/src/components/TerminalSearch.tsx
git commit -m "feat: wire searchStateRef through TerminalPane and TerminalSearch"
```

---

### Task 4: TypeScript build verification

**Files:** None (verification only)

- [ ] **Step 1: Run the TypeScript compiler to check for type errors**

Run: `pnpm run typecheck` (or the equivalent — check `package.json` scripts)
If no `typecheck` script exists, run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 2: Run the full test suite one final time**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 3: Commit if any fixes were needed, otherwise skip**
