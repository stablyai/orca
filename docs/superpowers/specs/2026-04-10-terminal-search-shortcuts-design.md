# Terminal Search Next/Previous Shortcuts

## Summary

Add `Cmd+G` (find next) and `Cmd+Shift+G` (find previous) keyboard shortcuts to navigate terminal search matches. These follow macOS native conventions and only activate when the search bar is already open.

## Requirements

- `Cmd+G` calls `findNext` on the active pane's `SearchAddon`
- `Cmd+Shift+G` calls `findPrevious` on the active pane's `SearchAddon`
- Shortcuts are no-ops when the search bar is closed
- After navigating, focus moves to the terminal (not the search input)
- Shortcuts are not documented in ShortcutsPane (consistent with `Cmd+F`)

## Architecture

### Data bridge: `searchStateRef`

The search query and options (`caseSensitive`, `regex`) live as local state in `TerminalSearch.tsx`. The keyboard handler in `keyboard-handlers.ts` needs read access to call `searchAddon.findNext(query, opts)`.

A `MutableRefObject<{ query: string; caseSensitive: boolean; regex: boolean }>` is created in `TerminalPane` and passed to both components. `TerminalSearch` writes to it on state changes; the keyboard handler reads from it on `Cmd+G` / `Cmd+Shift+G`. This follows the existing ref-bridge pattern used throughout `TerminalPane` (e.g., `paneTitlesRef`, `isActiveRef`, `settingsRef`).

### Changes by file

**`TerminalPane.tsx`**
- Create `searchStateRef = useRef({ query: '', caseSensitive: false, regex: false })`
- Pass `searchStateRef` to `TerminalSearch` as a new prop
- Pass `searchOpen` and `searchStateRef` to `useTerminalKeyboardShortcuts`

**`TerminalSearch.tsx`**
- Accept `searchStateRef: React.MutableRefObject<{ query: string; caseSensitive: boolean; regex: boolean }>` prop
- Sync the ref whenever `query`, `caseSensitive`, or `regex` changes (inside the existing `useEffect` or via direct assignment after `setState`)

**`keyboard-handlers.ts`**
- Add `searchOpen` (boolean) and `searchStateRef` to `KeyboardHandlersDeps`
- Add handler for `Cmd+G` / `Cmd+Shift+G` inside `onKeyDown`:
  - Guard: `searchOpen` must be true and `searchStateRef.current.query` must be non-empty
  - Read `query`, `caseSensitive`, `regex` from `searchStateRef.current`
  - Get active pane's `searchAddon` via `manager.getActivePane().searchAddon`
  - Call `findNext` or `findPrevious` with the current options
  - Call `pane.terminal.focus()` to return focus to the terminal
  - `preventDefault` + `stopPropagation`

### Edge cases

- **No query**: no-op (empty string guard)
- **No active pane**: no-op (existing pane guard)
- **Search closed**: no-op (`searchOpen` guard)
- **Key repeat**: filtered by existing `if (e.repeat) return` at top of `onKeyDown`
