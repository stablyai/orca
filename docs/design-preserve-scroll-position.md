# Design: Preserve Scroll Position Per File in Editor

## Context

When navigating between file tabs, the scroll position resets to the top because each editor component unmounts and remounts. The cursor line is already tracked per file via `editorCursorLine` in the store, but scroll position is not. This causes a poor UX when users switch between files frequently.

## Approach

Use a module-scoped `Map<string, number>` with LRU eviction, following the proven pattern from `CombinedDiffViewer` (lines 39–58). The scroll cache is extracted into a shared utility at `src/renderer/src/lib/scroll-cache.ts` so all viewer components share one bounded Map.

**Why not Zustand?** Scroll position updates at high frequency during user interaction. Putting it in Zustand means every write spreads a new object (`{ ...s.editorScrollTop, [fileId]: scrollTop }`), which (a) causes React re-render notifications even though no component subscribes to scroll position for rendering, and (b) generates object allocation churn on every scroll event. A module-scoped Map avoids both problems: zero re-renders, zero GC pressure, O(1) reads and writes. CombinedDiffViewer already validates this approach in production.

**Why LRU at 20 entries?** Without a cap, the Map grows unboundedly as unique file IDs accumulate across a session. 20 entries covers typical tab working sets with headroom. This matches `CombinedDiffViewer`'s existing cap and means no explicit cleanup is needed when files are closed — eviction is automatic.

## Files to Modify

### 1. Shared Utility: `src/renderer/src/lib/scroll-cache.ts` (new file)

Extract `setWithLRU` from `CombinedDiffViewer` into a shared module, and expose a single scroll cache Map:

```ts
const CACHE_MAX_ENTRIES = 20

// Why: Module-scoped Maps grow unboundedly as unique file keys accumulate.
// Cap them with a simple LRU eviction: after each set, if the map exceeds
// this limit, delete the oldest entry (Maps iterate in insertion order).
export function setWithLRU<K, V>(map: Map<K, V>, key: K, value: V): void {
  // Re-insert to refresh insertion order (move to end).
  map.delete(key)
  map.set(key, value)
  if (map.size > CACHE_MAX_ENTRIES) {
    const oldestKey = map.keys().next().value
    if (oldestKey !== undefined) {
      map.delete(oldestKey)
    }
  }
}

// Why: A single shared Map for scroll positions across all editor components.
// Module-scoped so it survives component unmount/remount without triggering
// React re-renders (unlike Zustand, which would broadcast state changes on
// every scroll event even though no component renders from scroll position).
export const scrollTopCache = new Map<string, number>()
```

After extracting, update `CombinedDiffViewer` to import `setWithLRU` from this module instead of defining it inline. `CombinedDiffViewer`'s own `combinedDiffViewStateCache` and `combinedDiffScrollTopCache` stay local since their value types are component-specific.

---

### 2. MonacoEditor: `src/renderer/src/components/editor/MonacoEditor.tsx`

**Save scroll position:**

In `handleMount` (line ~62), add a throttled scroll listener:

```ts
import { scrollTopCache, setWithLRU } from '@renderer/lib/scroll-cache'

// Why: Writing to the Map at 60fps (every scroll frame) is unnecessary since
// we only need the final position when the user stops scrolling or switches
// tabs. A trailing throttle of ~150ms captures the resting position while
// avoiding excessive writes.
let scrollThrottleTimer: ReturnType<typeof setTimeout> | null = null

editorInstance.onDidScrollChange((e) => {
  if (scrollThrottleTimer !== null) clearTimeout(scrollThrottleTimer)
  scrollThrottleTimer = setTimeout(() => {
    setWithLRU(scrollTopCache, filePath, e.scrollTop)
    scrollThrottleTimer = null
  }, 150)
})
```

Also snapshot the current position synchronously in the cleanup/unmount path (before the timeout fires) so tab switches always capture the latest value — same pattern as `CombinedDiffViewer`'s `updateCachedScrollPosition()` call in its cleanup return.

**Restore scroll position:**

In the `else` branch (line ~118) where there is NO pending reveal:

```ts
const savedScrollTop = scrollTopCache.get(filePath)
if (savedScrollTop !== undefined) {
  // Why: Monaco renders synchronously, so a single RAF is sufficient to
  // wait for the layout pass. Unlike react-markdown or Tiptap, there is
  // no async content loading that would require a retry loop.
  requestAnimationFrame(() => editorInstance.setScrollTop(savedScrollTop))
}
```

**Key edge case:** When `pendingEditorReveal` exists (search-result navigation), skip scroll restoration — `performReveal` handles its own scroll.

---

### 3. MarkdownPreview: `src/renderer/src/components/editor/MarkdownPreview.tsx`

**Mode-scoped cache key:**

```ts
// Why: Each markdown viewing mode (source/rich/preview) produces different
// DOM structures and content heights. A scroll position saved in source mode
// (a code block at line 500) has no meaningful correspondence in preview mode
// (rendered HTML at a completely different height). Using mode-scoped keys
// means each mode remembers its own position independently.
const scrollCacheKey = `${filePath}:preview`
```

**Save scroll position:**

Add a throttled scroll listener on `rootRef.current` (the scrollable div, line 192) via `useLayoutEffect`:

```ts
useLayoutEffect(() => {
  const container = rootRef.current
  if (!container) return

  let throttleTimer: ReturnType<typeof setTimeout> | null = null

  const onScroll = (): void => {
    if (throttleTimer !== null) clearTimeout(throttleTimer)
    throttleTimer = setTimeout(() => {
      setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
      throttleTimer = null
    }, 150)
  }

  container.addEventListener('scroll', onScroll, { passive: true })
  return () => {
    // Snapshot final position synchronously before detach.
    setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
    if (throttleTimer !== null) clearTimeout(throttleTimer)
    container.removeEventListener('scroll', onScroll)
  }
}, [scrollCacheKey])
```

**Restore scroll position (RAF retry loop):**

react-markdown renders asynchronously — content may not be in the DOM when the layout effect first runs, so `scrollHeight` is still small and `scrollTop` gets clamped to 0. Use `CombinedDiffViewer`'s RAF retry pattern (lines 353–388) to keep attempting until content has loaded:

```ts
useLayoutEffect(() => {
  const container = rootRef.current
  const targetScrollTop = scrollTopCache.get(scrollCacheKey)
  if (!container || targetScrollTop === undefined) return

  let frameId = 0
  let attempts = 0

  // Why: react-markdown renders asynchronously, so scrollHeight may still be
  // too small on the first frame. Retry up to 30 frames (~500ms at 60fps) to
  // accommodate content loading. This matches CombinedDiffViewer's proven
  // pattern for dynamic-height content restoration.
  const tryRestore = (): void => {
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
    const nextScrollTop = Math.min(targetScrollTop, maxScrollTop)
    container.scrollTop = nextScrollTop

    if (Math.abs(container.scrollTop - targetScrollTop) <= 1 || maxScrollTop >= targetScrollTop) {
      return
    }

    attempts += 1
    if (attempts < 30) {
      frameId = window.requestAnimationFrame(tryRestore)
    }
  }

  tryRestore()
  return () => window.cancelAnimationFrame(frameId)
}, [scrollCacheKey])
```

---

### 4. RichMarkdownEditor: `src/renderer/src/components/editor/RichMarkdownEditor.tsx`

Same approach as MarkdownPreview with two differences:

1. **Cache key:** `${filePath}:rich`
2. **Scroll container:** The scrollable container is `<EditorContent>` with `overflow-auto` (line 334). Wrap in a div with a ref to get the scroll container, move `overflow-auto` to wrapper.

The RAF retry loop is needed here too — Tiptap renders asynchronously as it hydrates its ProseMirror document, so `scrollHeight` may be undersized on the initial frame.

Save/restore logic is identical to MarkdownPreview, substituting the container ref and cache key.

---

### 5. DiffViewer — Deferred

DiffViewer doesn't currently receive `filePath` and diff views are typically opened for brief review. Deferring to avoid scope creep. `CombinedDiffViewer` already has its own scroll cache; if DiffViewer needs one later it can import from `scroll-cache.ts`.

## Edge Cases

| Case                                    | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending reveal (search nav)             | Scroll restoration skipped; `performReveal` takes priority                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| First open (no saved position)          | `undefined` in cache → no restoration, starts at top                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Markdown mode switch (source → preview) | Mode-scoped keys (`path:source`, `path:preview`, `path:rich`) mean each mode preserves its own position independently. No cross-mode confusion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Scroll at 0                             | Always restore (including 0) to guard against Monaco auto-scroll behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| External file content changes           | **Known trade-off:** When external changes add/remove content above the viewport, the saved scroll position points to different content. Monaco clamps `scrollTop` if it exceeds the new document length, but does not adjust for insertions above the viewport. HTML containers (`MarkdownPreview`, `RichMarkdownEditor`) behave the same way — the browser clamps `scrollTop` to `scrollHeight - clientHeight`. This is acceptable: scroll position is a best-effort hint, not a semantic anchor. Fixing this would require mapping scroll offsets to content anchors (like line numbers), which is out of scope. |
| LRU eviction (>20 files)                | Oldest scroll entry is evicted. User sees top-of-file on return to a very old tab — same as a fresh open. No data corruption or memory leak.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Close file, reopen                      | LRU may or may not still have the entry. If present, position restores. If evicted, starts at top. No explicit cleanup needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Async content (react-markdown, Tiptap)  | RAF retry loop (up to 30 attempts) handles content that renders after the initial layout pass. Falls back to best-effort clamped position if content never reaches the target height.                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Verification

1. Open a code file, scroll down ~50%, switch to another tab, switch back → verify position preserved
2. Open a markdown file in preview mode, scroll down, switch tabs, return → verify position preserved
3. Open a markdown file in rich mode, scroll down, switch tabs, return → verify position preserved
4. Switch a markdown file from source to preview mode → verify each mode has independent scroll position (scroll in source, switch to preview, preview starts at its own saved position or top)
5. Use Cmd+Shift+F to search, click a result → verify it scrolls to the match (NOT saved position)
6. Open 25+ files to trigger LRU eviction, return to the earliest file → verify it starts at top gracefully
7. `pnpm run typecheck` passes
