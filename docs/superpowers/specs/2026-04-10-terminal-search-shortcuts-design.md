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
- Sync the ref whenever `query`, `caseSensitive`, or `regex` changes — inside the existing `useEffect` that already depends on `[query, caseSensitive, regex]`, so all three values are kept in sync together. Note: the existing effect has an early return when query is empty (`clearDecorations`), so the ref won't update on clear — this is benign because the keyboard handler already guards on non-empty query

**`keyboard-handlers.ts`**
- Add `searchOpen` (boolean) and `searchStateRef` to `KeyboardHandlersDeps`
- Exempt `[data-terminal-search-root]` descendants from the `isEditableTarget` early return for `Cmd+G` / `Cmd+Shift+G`. Without this, pressing the shortcut while the search input has focus would be silently swallowed. The paste handler in `TerminalPane` already uses this same `data-terminal-search-root` exemption pattern.
- Add handler for `Cmd+G` / `Cmd+Shift+G` inside `onKeyDown`, placed before the `isEditableTarget` guard. Because this runs before the `const mod = ...` declaration, the handler must perform its own mod-key check (`isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey`) and key match (`e.key.toLowerCase() === 'g'`) inline:
  - Guard: mod key active, key is `g`, `searchOpen` is true, `searchStateRef.current.query` is non-empty
  - Read `query`, `caseSensitive`, `regex` from `searchStateRef.current`
  - Get active pane's `searchAddon` via `manager.getActivePane().searchAddon`
  - Call `findNext` or `findPrevious` with `{ caseSensitive, regex }` (no `incremental` — matches the chevron button behavior, not the live-typing behavior)
  - Call `pane.terminal.focus()` to return focus to the terminal
  - `preventDefault` + `stopPropagation` — important to suppress macOS/Electron's native "find next" which could otherwise trigger the built-in find bar

### Edge cases

- **No query**: no-op (empty string guard)
- **No active pane**: no-op (existing pane guard)
- **Search closed**: no-op (`searchOpen` guard)
- **Key repeat**: filtered by existing `if (e.repeat) return` at top of `onKeyDown`
- **Focus in search input**: `Cmd+G` / `Cmd+Shift+G` must bypass the `isEditableTarget` guard for search input descendants (see keyboard-handlers.ts changes above)
