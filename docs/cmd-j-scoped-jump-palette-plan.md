# Design Document: Scoped Cmd+J Jump Palette for Worktrees and Browser Tabs

**Status:** Draft
**Date:** 2026-04-15

## 1. Summary

Extend Orca's existing `Cmd+J` / `Ctrl+Shift+J` worktree palette into a single app-wide jump surface with explicit scopes. The first release keeps the palette centered on two jobs:

- jump to a worktree
- jump to an already-open browser page across any worktree

The palette opens into a lightweight scope switcher with three modes:

- `All`
- `Worktrees`
- `Browser Tabs`

Users can press `Tab` / `Shift+Tab` to cycle scopes without leaving the keyboard. The default contract on open remains `Worktrees`, not `All`, so existing users still land in the familiar worktree-first flow before opting into broader search. Search results stay intentionally narrow: browser-only discovery is supported because the user explicitly needs to find already-open pages across worktrees, but the palette does not become a generic "everything" bucket in v1.

## 1.1 Phase 0.5 Direction Lock

Phase 0.5 locked three product decisions for v1:

- `Cmd+J` still opens into `Worktrees` by default.
- Browser discovery indexes live open `BrowserPage`s, not just browser workspace containers.
- Browser ordering uses a simple context-first heuristic instead of true last-focused recency state.

Why these decisions were chosen:

- `Cmd+J` already has a strong worktree-switching contract in Orca. Making `All` the default would silently turn a familiar command into a mixed-ranking surface and force existing users to re-learn the first screen they see.
- The remembered object in the browser case is the page itself. Searching only browser workspace shells would miss the page-level titles and URLs users actually recall when they say "I know I already have this open somewhere."
- True global browser recency would require new focus-tracking state whose only initial consumer is palette ranking. A simple heuristic is easier to ship, easier to explain, and good enough for the first version of this discovery workflow.

## 2. Problem

Orca already supports multiple concurrent worktrees and persistent in-app browser tabs. Users can jump between worktrees with the existing `Cmd+J` palette, but they cannot quickly answer a more specific question:

> "I know I already have this page open somewhere. Which worktree is it in, and how do I get back to it?"

The current worktree palette is container-first. That works when the user remembers the worktree identity, but it breaks down when the remembered thing is a page title, host, or URL path.

This is a discovery problem, not a recency problem. A cycle UI is poor at it because:

- the user often does not know which worktree owns the target tab
- multiple browser tabs can share similar titles
- cycling scales badly once many worktrees have open tabs

## 3. Goals

- Preserve `Cmd+J` / `Ctrl+Shift+J` as Orca's single global jump entry point.
- Let users search open browser pages across all worktrees.
- Keep worktree search fast and familiar for existing users.
- Make scope switching explicit and keyboard-first.
- Avoid overcommitting Orca to a generic "search all open items" model before the product is ready to support terminals, editors, and commands consistently.
- Preserve the existing expectation that `Cmd+J` opens as a worktree-first jump flow.

## 4. Non-Goals

- Searching terminal scrollback or editor contents.
- Adding a persistent sidebar or browser-tab manager panel.
- Replacing local `Ctrl+Tab` behavior or introducing a new cycle UI.
- Expanding `Cmd+J` into files, terminals, editor tabs, or commands in this change.

## 5. UX

### 5.1 Entry Point

Keep the existing shortcut:

- macOS: `Cmd+J`
- Windows/Linux: `Ctrl+Shift+J`

This shortcut already means "global jump" inside Orca and is already forwarded correctly even when an embedded browser guest owns focus. Reusing it preserves muscle memory and avoids proliferating navigation surfaces.

### 5.2 Scope Model

The palette header contains three explicit scope chips:

- `All`
- `Worktrees`
- `Browser Tabs`

Keyboard behavior:

- `Tab`: next scope
- `Shift+Tab`: previous scope
- `Up` / `Down`: move selection within results
- `Enter`: activate selected result
- `Esc`: close palette

Default scope on open: `Worktrees`.

Why this shape:

- one entry point is easier to remember than separate dialogs
- explicit scopes prevent a mixed list from becoming noisy
- `Tab` matches the mental model of "move across modes" without conflicting with list navigation
- opening in `Worktrees` preserves today's default behavior and makes `All` an explicit expansion, not a silent contract change

### 5.3 Scope Semantics

#### `All`

Merged result list of:

- open browser pages across all worktrees
- worktrees across all repos

Ranking rules:

- strong browser title matches rank above weak worktree metadata matches
- host/url matches get boosted when the query resembles a domain, URL, or path fragment
- exact worktree name matches still beat weak browser matches
- current worktree/current browser page receive a small context boost when otherwise tied
- browser results use the same heuristic ordering as `Browser Tabs`; v1 does not add hidden last-focused browser recency state just for this merged scope

`All` is meant to feel smart, not exhaustive.

#### `Worktrees`

Equivalent to today's worktree palette behavior:

- same global search semantics for worktree metadata
- same recent-first ordering for the default empty-query state
- same selection and activation behavior

#### `Browser Tabs`

Shows only open browser pages across all worktrees. The user-facing scope label stays `Browser Tabs`, but each row maps to a live `BrowserPage`, not a browser workspace shell.

Empty query ordering:

1. current browser page, if any
2. other open browser pages in the current worktree
3. browser pages in other worktrees, grouped by the existing worktree ordering and then sorted by title, falling back to URL

This mode is the direct answer to "just show me all open browsers."

Why this ordering:

- it pulls the user's current context to the top without inventing new global recency state
- it stays stable enough that users can learn where results tend to land
- it keeps the implementation honest about what Orca already knows today versus what would require new focus-history plumbing

### 5.4 Result Rows

#### Browser tab row

Primary text:

- current page title, falling back to formatted URL when the title is blank or useless

Secondary text:

- host + trimmed path

Context chips on the right:

- repo name
- worktree display name

Optional badges:

- `Current Tab`
- `Current Worktree`

Why this is required:

- browser tab titles are often duplicated (`localhost`, `Settings`, `Dashboard`)
- users need immediate disambiguation without opening the result
- worktree context is the whole point of the feature
- each row represents the actual page the user remembers, while worktree and repo chips explain where that page lives

#### Worktree row

Keep the existing row structure:

- worktree display name
- branch
- optional supporting text for comment / PR / issue
- repo badge

This avoids making existing users relearn the palette.

### 5.5 Empty States

`All`

- If no worktrees and no browser tabs exist: `No worktrees or open browser tabs`
- If query yields no results: `No matches in worktrees or browser tabs`

`Worktrees`

- Preserve existing copy

`Browser Tabs`

- No open browser tabs: `No open browser tabs`
- No query matches: `No browser tabs match your search`

### 5.6 Activation Behavior

Selecting a worktree result:

- preserve current `activateAndRevealWorktree(worktreeId)` behavior

Selecting a browser result:

1. activate and reveal the owning worktree
2. focus the target browser workspace tab
3. select the target `BrowserPage` inside that workspace
4. set `activeTabType` to `browser`
5. close the palette
6. restore focus into the browser surface, not the terminal/editor fallback

Why this ordering matters:

- browser pages are subordinate to worktree activation in Orca's model
- worktree-first activation restores the right workspace state and sidebar visibility
- selecting a browser result should feel like "take me there directly," not "switch worktree and make me pick again"

## 6. Data Model and Search Inputs

### 6.1 Worktree Results

Use the existing search surface:

- `displayName`
- branch
- repo name
- comment
- linked PR number/title
- linked issue number/title

### 6.2 Browser Tab Results

Search only currently open browser pages, not history and not just browser workspace shells.

For each browser result, index:

- page title
- page URL
- formatted host/path
- owning browser workspace label, if available
- owning worktree display name
- owning repo display name

Each open `BrowserPage` contributes its own result row. Browser workspaces still matter for ownership and activation, but they are context, not the searchable unit.

This is intentionally limited to live open pages because Orca still is not an app-wide browsing history system. The goal is to help users recover something they already have open, not to introduce a second browsing history feature through the palette.

### 6.3 Why Not Terminal Tabs Yet

Terminal tabs are deliberately out of scope for text-first search in this change.

Reasons:

- terminal tab titles are less stable and less descriptive than browser titles
- the meaningful part of a terminal session often lives in scrollback, not tab metadata
- adding terminal tabs only because browser tabs are added would create a low-signal mixed palette

This design keeps the palette honest: it supports browser-page search because that metadata makes the target genuinely searchable. If Orca later wants an "all open items" palette, that should be a deliberate follow-up with result quality standards for each item type.

## 7. Architecture

### 7.1 Existing Pieces Reused

- `WorktreeJumpPalette.tsx` remains the base surface and interaction shell.
- Existing worktree search logic remains intact for the `Worktrees` scope.
- Browser search input comes from the live open `BrowserPage`s already held by renderer browser state.
- Browser activation continues to use the existing browser-workspace activation pathway after worktree activation, then selects the matching page inside that workspace.
- Main-process shortcut forwarding remains unchanged.

### 7.2 New Search Model

Add a palette view-model layer that produces typed results:

```ts
type JumpPaletteScope = 'all' | 'worktrees' | 'browser-tabs'

type JumpPaletteResult =
  | { type: 'worktree'; worktreeId: string; score: number; ... }
  | {
      type: 'browser-page'
      worktreeId: string
      browserTabId: string
      browserPageId: string
      score: number
      ...
    }
```

The existing worktree search helper remains responsible for worktree scoring. A new browser-page search helper handles browser result scoring and formatting. The palette shell merges and sorts results only in `All`.

Why split the search helpers:

- worktree matching logic is already non-trivial and should not be regressed
- browser result ranking has different signals than worktree ranking
- typed results keep selection and rendering explicit instead of relying on ad hoc ID prefixes
- page-level browser hits need both workspace ownership and page identity for activation

### 7.3 Focus and Close Semantics

The existing palette already manages focus restoration carefully. That logic should be extended, not replaced.

New rule:

- if the selected result is a browser page, the post-close focus path targets the active browser surface
- otherwise preserve today's terminal/editor focus restoration behavior

### 7.4 System Context

```text
+------------------+        +-----------------------+
| Main Process     |        | Renderer Store        |
| shortcut forward | -----> | activeModal           |
| Cmd+J / Ctrl+... |        | worktreesByRepo       |
+------------------+        | browser state         |
                            | activeWorktreeId      |
                            +-----------+-----------+
                                        |
                                        v
                            +------------------------+
                            | Cmd+J Jump Palette     |
                            | scopes + search + list |
                            +-----+-------------+----+
                                  |             |
                    worktree hit   |             | browser-page hit
                                  v             v
                     +------------------+   +---------------------+
                     | activate/reveal  |   | activate/reveal     |
                     | target worktree  |   | target worktree     |
                     +------------------+   +----------+----------+
                                                       |
                                                       v
                                            +----------------------+
                                            | activate browser     |
                                            | workspace + page     |
                                            | focus browser pane   |
                                            +----------------------+
```

### 7.5 Data Flows

#### Happy path: browser-page search and jump

```text
Cmd+J -> palette opens in Worktrees -> user switches to Browser Tabs ->
query matches browser page ->
user presses Enter -> activateAndRevealWorktree(worktreeId) ->
activate target browser workspace and page -> palette closes -> browser surface focused
```

#### Nil path: user opens palette with no browser pages

```text
Cmd+J -> palette opens -> Browser Tabs scope selected ->
search model sees zero browser pages -> empty state shown -> no side effects
```

#### Empty path: query yields no browser or worktree matches

```text
query typed -> search returns [] -> scope-specific empty state rendered ->
selection cleared or pinned to no result -> Enter does nothing
```

#### Upstream error path: selected browser page disappears before activation

```text
user selects browser result -> store lookup fails because page/worktree closed ->
show toast error -> keep palette open if possible, otherwise close safely without switching
```

## 8. Alternatives Considered

### 8.1 Dedicated browser-tab-only dialog

Pros:

- clearer mental model for the browser-specific job
- no mixed-result ranking complexity

Cons:

- adds another shortcut and another navigation surface
- weakens `Cmd+J` as the single place to jump around Orca

Decision: rejected for now. The scoped palette gives the same utility with less surface area.

### 8.2 Browser tabs only inside `Cmd+J`, no scopes

Pros:

- least new UI chrome

Cons:

- mixed results become harder to reason about
- users cannot quickly answer "just show me browser tabs"

Decision: rejected. Explicit scopes are worth the small extra header chrome.

### 8.3 Expand immediately to terminals, files, and commands

Pros:

- one "go to anything" story

Cons:

- scope explosion
- result quality is uneven across item types
- much higher design and implementation complexity

Decision: rejected for v1. Start with the two jobs the user clearly asked for.

### 8.4 Make `All` the default scope

Pros:

- makes browser discovery visible immediately
- creates a more obviously "global" first impression

Cons:

- breaks the current worktree-first contract of `Cmd+J`
- makes the first screen depend on mixed ranking logic instead of today's predictable worktree list

Decision: rejected for v1. `All` remains available, but opening in `Worktrees` preserves muscle memory and keeps the expansion explicit.

### 8.5 Search browser workspaces instead of live pages

Pros:

- simpler indexing model
- reuses the existing browser workspace abstraction directly

Cons:

- misses the page titles and URLs users actually remember
- treats the container as the search target even when the user wants a specific page inside it

Decision: rejected. The palette should index the page the user is trying to recover, then use workspace and worktree context to explain where it lives.

### 8.6 Add true browser recency tracking for v1 ranking

Pros:

- could produce sharper empty-query ordering over time

Cons:

- requires new state and focus bookkeeping for a thin initial payoff
- introduces ranking behavior that is harder to explain and debug

Decision: rejected for v1. Start with a deterministic context-first heuristic and revisit true recency only if usage shows the heuristic is insufficient.

## 9. Rollout

### Phase 1

- Add scoped header to the existing `Cmd+J` palette
- Keep `Worktrees` as the default scope on open
- Preserve worktree-only behavior under the `Worktrees` scope
- Add browser-page search and activation
- Search live open `BrowserPage`s rather than browser workspace shells
- Add `All` merged ranking

### Phase 2 (optional follow-up)

- Evaluate whether users need additional scopes such as editor tabs or commands
- Only add a new scope if it has a clear, high-signal search model

## 10. Open Questions

- Whether a later iteration should remember a last-used non-default scope without changing the default-open `Worktrees` contract
- Whether browser-tab results should expose close actions from the palette in a later pass
- Whether `All` should group results visually by type or keep one flat ranked list
