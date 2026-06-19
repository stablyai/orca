# Show Full Tab Title Tooltip

## Problem

Issue #2966 reports that long tab titles are truncated with an ellipsis but do not expose the full name on hover or focus.

- Terminal tab labels render in `src/renderer/src/components/tab-bar/SortableTab.tsx:324` as `truncate max-w-[72px]` with no tooltip.
- Browser tab labels render in `src/renderer/src/components/tab-bar/BrowserTab.tsx:163` as `truncate max-w-[100px]` with no tooltip.
- Editor tab labels render in `src/renderer/src/components/tab-bar/EditorFileTab.tsx:289` as `truncate max-w-[80px]` with no tooltip.
- The app already has a Radix-backed shadcn tooltip wrapper in `src/renderer/src/components/ui/tooltip.tsx:23`.
- The app-level `TooltipProvider` is mounted in `src/renderer/src/App.tsx` with `delayDuration={400}`; this feature should use that provider, not add another one.

## Root Cause

The tab components render plain text spans for their ellipsized labels. The full title exists in component state, but the focusable tab root is not wired to the shared `Tooltip`/`TooltipTrigger`/`TooltipContent` primitive, so neither hover nor keyboard focus exposes it.

## Non-Goals

- Do not change tab width, scrolling, drag-and-drop behavior, context menus, title generation, or rename semantics.
- Do not add persistence, IPC, or main-process behavior.
- Do not replace the tab bar layout or introduce a new tooltip primitive.
- Do not add custom overflow measurement in this pass unless a reviewed implementation finds the always-available tooltip materially harmful.

## Design

1. Add full-title tooltips to non-editing tabs in the existing tab components.
   - Terminal: display `tab.customTitle ?? tab.title`.
   - Browser: display `getBrowserTabLabel(tab)`.
   - Editor: display `getEditorDisplayLabel(file)`, preserving preview italic and external mutation/status adornments outside the label.
2. Use the existing shadcn tooltip primitive from `@/components/ui/tooltip`.
   - Do not add a nested `TooltipProvider`; the app root already supplies the 400ms delay required by the style guide.
   - In non-rename states, wrap the sortable tab root with `<Tooltip><TooltipTrigger asChild>...` so both pointer hover and keyboard focus on the dnd-kit focusable tab (`role`, `tabIndex=0`) surface the tooltip.
   - Keep the tooltip gated off while a context menu is open. Right-click opens a Radix menu from the same root hover area, so the full-title tooltip must not remain visible over the menu.
   - Do not make the label span itself the only trigger: it is not focusable today, and adding `tabIndex` to the label would create a second keyboard stop inside each tab.
   - Render `<TooltipContent side="bottom" sideOffset={6} className="max-w-80 whitespace-normal break-words text-left">full label</TooltipContent>`.
   - `side="bottom"` is intentional because the tab strip sits at the top edge; Radix collision handling can still flip/shift when needed.
   - Keep tooltip content non-interactive; it is only a label.
3. Keep edit states out of the tooltip path.
   - Terminal rename input and editor rename input should remain direct inputs with no tooltip wrapper. Editor rename is nested inside an otherwise sortable root, so `isRenaming` must also disable the root tooltip, not only the label span tooltip.
   - Double-click handlers for rename/pin must keep their current event behavior.
4. Preserve drag, activation, and close controls.
   - `TooltipTrigger asChild` must attach to the existing sortable root element without introducing a new DOM wrapper, so `setNodeRef`, dnd-kit attributes/listeners, activation, context-menu capture, middle-click close, and close/collapse buttons keep their current event paths.
   - Because wrapping the root makes the entire tab chrome a tooltip trigger, Electron validation must check the tooltip does not obscure or compete with close/collapse/context-menu affordances. The shared `TooltipContent` is already `pointer-events-none`, but visual overlap and native `title` on the terminal collapse button still need checking.
   - The outer tab remains the sortable/activation target.
5. Add focused regression coverage for the render contract.
   - Unit tests should assert that terminal, browser, and editor rendered tab roots are passed through the tooltip primitive with the correct full label.
   - Tests can mock tooltip components to avoid Radix portal timing and assert structural wiring. Because these components call hooks and the Vitest environment is Node-only, render them with `react-dom/server` or another existing local pattern, and mock `@dnd-kit/sortable` so the root exposes deterministic `role`/`tabIndex` attributes.

## Data Flow

- Store/runtime tab state updates title fields.
- `TabBar` maps current visible tabs to `SortableTab`, `BrowserTab`, and `EditorFileTab`.
- Each tab component computes the displayed label.
- The non-editing sortable root remains the trigger so pointer hover and keyboard focus share the same tooltip path.
- Hover/focus opens Radix tooltip content containing the same full label after the app's normal 400ms delay.
- Title changes from runtime/browser/editor state re-render the same component; do not cache tooltip text outside the render path.

## Edge Cases

- Terminal custom title overrides the runtime title in both visible label and tooltip.
- Terminal title updates from remote/SSH PTY state should update the tooltip through normal React props.
- Browser tab with missing/blank title should show the URL-derived fallback or `New Tab`, matching the visible label.
- Browser tooltip text must use `getBrowserTabLabel(tab)` from the same `tab` prop as the visible label, not `getLiveBrowserUrl` or the redacted context-menu URL; otherwise live URL drift can make the tooltip disagree with the tab.
- Editor preview, dirty, git-status, conflict-review, diff, markdown-preview, and external-mutation labels should keep existing styling and adjacent badges.
- Rename modes must not show stale title tooltips over the input.
- Keyboard focus on a terminal, browser, or editor tab must show the same tooltip as hover. The existing dnd-kit root provides the focus target; do not add focusable descendants for tooltip-only behavior.
- Context menu, middle-click close, drag start, and split drop indicators must still work because the sortable root and pointer handlers remain unchanged.
- Very long tooltip text should wrap within a bounded width and stay readable in light/dark themes.
- Context-menu open must force the corresponding tooltip closed for terminal, browser, and editor tabs.
- Hovering root-child controls such as close, terminal collapse, loading indicators, dirty dots, and status badges may enter the root trigger; the tooltip must remain non-blocking and should not create duplicate/conflicting hover copy that makes those controls harder to use.
- Multi-window and web/SSH remote-client paths should need no IPC or persistence work because this is renderer-only display of existing tab state. The implementation must still derive text from current props every render so external title/file mutations do not leave stale tooltip content while a tab remains mounted.

## Test Plan

- Unit: add or update tab-bar component tests that mock tooltip primitives and assert:
  - terminal tab label tooltip content uses custom title when present;
  - browser tab label tooltip content uses `getBrowserTabLabel`;
  - editor tab label tooltip content uses `getEditorDisplayLabel`;
  - the tooltip trigger is the sortable root in non-rename mode, preserving dnd-kit `role`/`tabIndex` focusability;
  - rename/context-menu suppression is unit-tested only where the implementation exposes that state through a small testable render path; do not contort Node-only server-render tests to fake private interactive state.
- Integration/Electron: create long terminal/browser/editor tab labels, hover each tab, wait for the app's 400ms tooltip delay, and verify a tooltip with the full label appears while tab activation/close still works.
- Integration/Electron: keyboard-focus one terminal, browser, and editor tab and verify the tooltip appears without adding an extra tab stop inside the label.
- Integration/Electron: enter terminal/editor rename modes and open terminal/browser/editor context menus, then verify the full-title tooltip is absent or dismissed.
- Regression: run `pnpm typecheck`, `pnpm lint`, and the relevant tab-bar Vitest tests via `pnpm test -- <test-file>` if focused files are added.

## UI Quality Bar

- Tooltip appears near the hovered/focused truncated label without covering the close button unnecessarily.
- Tooltip uses existing Orca token-based styling through `TooltipContent`; no new colors, shadows, or typography.
- Long text wraps at a readable max width, including long path/URL segments, and does not clip off-screen in a normal desktop viewport.
- Tab dimensions, hover colors, active indicator, unread bell, dirty dot, git status, and close-button reveal behavior do not shift.
- Light and dark theme surfaces remain legible.

## Review Screenshots

1. Terminal tab with a long custom or runtime title hovered, showing the full title tooltip.
2. Browser tab with a long page title or URL hovered, showing the full title tooltip.
3. Editor tab with a long filename/path-derived label hovered, showing the full title tooltip while dirty/status adornments still look unchanged.
4. Adjacent smoke state: a keyboard-focused tab shows the tooltip, and close/context-menu affordances still work after tooltip wiring.

## Rollout

1. Add tooltip imports and wrap the non-editing sortable tab roots in `SortableTab`, `BrowserTab`, and `EditorFileTab`.
2. Add focused tests for tooltip label wiring.
3. Run relevant tests, typecheck, and lint.
4. Validate in Electron with hover screenshots for terminal, browser, editor, and adjacent tab controls.

## Lightweight Eng Review

- Scope: kept to renderer tab-label rendering only. No overflow observer, persistence, IPC, or new primitive is needed to satisfy the issue.
- Architecture/data flow: title data already reaches the tab components; tooltip content should be derived in the same component that renders each visible label. This keeps terminal, browser, and editor ownership unchanged and avoids cross-window/SSH special cases. The trigger must be the focusable sortable root, not the inner label span, because the issue requires focus behavior.
- Failure modes covered:
  - Tooltip root/trigger wiring could interfere with drag/activation if it adds an extra DOM wrapper or drops the dnd-kit ref/listeners/attributes.
  - Rename mode could show stale tooltip content over an input if the tooltip is not gated out.
  - Context-menu open could leave a delayed tooltip rendered over menu items unless `menuOpen` suppresses it.
  - Long tooltip text could overflow the viewport if content width is unbounded.
  - Browser fallback labels could drift if tooltip recomputes a different label than the visible span.
  - Editor badges/status text could shift if the tooltip adds a block wrapper inside the label row.
  - Root-level hover could show the tooltip while the pointer is over close/collapse/context-menu surfaces; validation must prove it does not block those controls or create unusable duplicate copy.
- Test coverage required:
  - Unit/component: tab-bar label tooltip wiring for terminal, browser, and editor components.
  - Unit/component: terminal custom title precedence, browser fallback label parity, and non-rename root trigger focusability.
  - Electron validation: hover, keyboard-focus, rename suppression, context-menu suppression, and adjacent close/context-menu smoke for terminal/browser/editor labels.
- Performance/blast radius: small but not free. This adds one Radix tooltip root per visible tab and a few event handlers on the existing tab root; that is acceptable because tab count is bounded by rendered tabs and there is no IPC, polling, file watching, persistence, startup work, or overflow measurement.
- UI quality bar: existing tooltip primitive only, bounded wrapping, no tab-size shift, no overlap with close/action affordances, legible in light/dark.
- Required review screenshots:
  1. Long terminal tab tooltip.
  2. Long browser tab tooltip.
  3. Long editor tab tooltip with existing adornments intact.
  4. Keyboard-focus tooltip plus adjacent close/context-menu smoke state.
- Residual risks: Radix `TooltipTrigger asChild` must merge props/ref with the dnd-kit sortable root without disrupting pointer or keyboard drag behavior; unit tests with mocked dnd-kit can only prove wiring, so Electron validation must explicitly cover drag/activation adjacency, context-menu suppression, and focus-triggered display.
