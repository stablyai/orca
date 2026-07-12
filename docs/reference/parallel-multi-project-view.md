# Design Doc: Parallel Multi-Project View (Worktree-Level Split Layout + Project Super-Tabs)

**Status:** Proposal · **Date:** 2026-07-12 · **Tracking issue:** #8377
**Related:** #7741 (Open in New Window), #7811 (Move tab to floating workspace) — partial overlap on the floating facet only. **Not** related in model to #1099/#7711 (multi-root workspaces) — see §3.

---

## 0. Direction, sequencing & competitive positioning (decided)

These decisions were made collaboratively and constrain the rest of the doc.

**Unified workbench — single project is the N=1 case, not a separate mode.** Orca's thesis is multi-agent orchestration, yet the workbench shows exactly one worktree at a time (`Terminal.tsx:256`, `renderedActiveWorktreeId = activeWorktreeId`). We do **not** add a "parallel mode" alongside a preserved "single mode" — that would encode "serial by default, parallel is an option," the wrong signal for a parallel-first product, and doubles the codepaths. Instead the workbench **is** a composable multi-worktree surface whose minimum is one leaf. A one-leaf view is pixel/behavior-identical to today (chrome hidden), so single-project users see no change — the single view is *subsumed*, not removed. The render gate becomes a single `visibleWorktreeIds` set (`size === 1` = today, `size === 2` = parallel — same code), which *reduces* special-case branching and thus regression risk.

**Two surfaces on one model, sequenced A → B:**

- **Surface A — in-window project super-tab + capped side-by-side worktree tiling. Primary scope; build first.** Renderer-contained (no main-process changes beyond menu items); reuses the proven split engine. Directly solves the most common unmet need: seeing parallel worktrees of the *same* project (or different projects) at once instead of flipping the sidebar.
- **Surface B — detach a project:worktree into a real second OS window** (OS-managed placement / multi-monitor). Same unit as a super-tab. **Deferred**, because the main process assumes a single window: **~465 `webContents.send` call sites** and **~1084 `mainWindow` references** would need to become multi-window-aware (targeted/broadcast + a window registry + per-worktree PTY ownership). Highest blast-radius of the two despite the simplest-sounding UX. Tracked toward #7741 and the OS-window facet of #7811; needs its own foundation before it is safe to land.

**Capped, intentional tiling (2–4), sidebar as the overview.** Humans can't actively watch many live agents; Conductor's own guidance is "3–5 workspaces is the sweet spot," and the market drifts to boards for managing many. So Surface A tiles a *few* focused worktrees (soft cap 4 / hard cap 6, NFR-2) while the existing left Sidebar (`WorktreeList`) remains the "manage many" overview — no separate kanban board is needed.

**The Sidebar is the parent — no super-tab strip (decided).** There is deliberately **no** second tab layer above the content `TabBar`. The left Sidebar (`WorktreeList`) is *already* the parent representation of every worktree (grouped by project/group/repo), so a stacked super-tab strip would just duplicate it and add noise. In the parallel view the only thing a pane must convey is **which sidebar group it belongs to** — shown as a compact per-pane **sidebar-group indicator** (project name + the sidebar group's color/badge) integrated into the pane's existing tab bar, not a new row. At N=1 there is zero extra chrome (identical to today); the indicator appears only when ≥2 panes are visible. What is shown in parallel is driven from the Sidebar (the triggers in §6.5) plus a "visible in parallel" affordance on its rows — the Sidebar is both overview and control surface. This supersedes the `ProjectTabStrip` references elsewhere in this doc (no such component is built); the `shouldShowProjectTabStrip` selector is kept only to gate the per-pane indicator's appearance, and the workbench-view model degrades to a single current layout (no view-switcher UI).

**Competitive positioning (sourced survey of Orca-like ADEs).** The parallelism *unit* has converged on the git **worktree** (Superset, cmux, Conductor, Crystal/Nimbalyst, Vibe Kanban, Warp, Zed; Sculptor dissents with containers) — validating worktree as the pane unit. The *viewing* layer has **not** converged, and two things are essentially unbuilt in purpose-built ADEs, which is where Orca can differentiate:
- **Genuine side-by-side tiling** exists only in terminal-native tools (cmux, Warp); editor/dashboard ADEs (Superset — explicitly one-project-at-a-time; Conductor; Crystal; Zed) focus one at a time. Surface A combines tiling with ADE review UX (diff/PR).
- **A project-level tab strip** is essentially unbuilt (Warp has an open request, `warpdotdev/warp#9382`); Superset/Zed/Warp only group by project inside a sidebar.
- **Detach-to-OS-window** is offered by *no* purpose-built ADE (only Warp/Zed inherit it from their base app) — Surface B would be category-first.

---

## 1. Summary

Orca today renders exactly **one worktree at a time** in the workbench; parallelism exists only *inside* a worktree (tab-group splits) or via the in-renderer floating overlay. This document designs a new **worktree-level split layout**: a recursive layout tree whose **leaves are worktrees** — directly analogous to the existing `TabGroupLayoutNode` whose leaves are tab groups — slotted between the center-column workbench (`App.tsx:2396`) and each worktree's `WorktreeSplitSurface` (`Terminal.tsx:2375`). Because every `Worktree` carries a `projectId` (`shared/types.ts:446`), a split whose leaves belong to different projects **is** the requested "parallel project view." A **project super-tab strip** (`ProjectTabStrip`) above the workbench manages named *workbench views* (saved arrangements), and an optional later phase detaches a view into a **real OS window**. The design maximally reuses the proven split engine (`TabGroupSplitLayout.tsx`, `useTabDragSplit.ts`, `ResizeHandle`) and keeps `activeWorktreeId` as the single "focused worktree," so the ~40 per-worktree-keyed store maps remain valid unchanged.

---

## 2. Problem & Motivation

Orca's window/tab layout is isolated per project. The left Sidebar switches which single worktree occupies the workbench (`setActiveWorktree`, `worktrees.ts:4378`); every other worktree stays mounted but hidden (`absolute inset-0 hidden`, `Terminal.tsx:2408-2416`). Users who operate several agentic sessions at once cannot *see* them at once.

Concrete use cases:

1. **Multiple projects in parallel.** A user runs an agent in project A while reviewing diffs in project B — today this means constant Sidebar/Cmd+J flipping, losing visual continuity of the agent's terminal output.
2. **Same repo, multiple physical clones.** A user clones one repository into two or more folders (e.g., `~/dev/orca` and `~/dev/orca-experiment`) to run divergent agent sessions. Each clone is a distinct Project/Repo/Worktree in Orca (worktree id = `` `${repoId}::${path}` ``, `types.ts:446`), but they can never be compared side by side.
3. **Cross-host work.** One project on the local machine, another on an SSH or WSL host (`Worktree.hostId`). Watching both simultaneously is currently impossible.
4. **Multi-monitor.** Users want to throw one project onto a second display — today's "floating workspace" is an in-renderer overlay (`FloatingTerminalPanel`, `App.tsx:2507`), trapped inside the single `BrowserWindow` (`createMainWindow.ts:150`, created once at `src/main/index.ts:810`).

---

## 3. Terminology Reconciliation

The user asks for a "parallel **project** view" and "a tab layer **above** the current tab level." Mapping onto Orca's real containment hierarchy:

```
Project (types.ts:107)            ← data-model + Sidebar grouping ONLY; not a layout container
 └─ Repo (types.ts:231)
     └─ Worktree (types.ts:446)   ← the actual parallel/workspace unit (has projectId, repoId, hostId)
         └─ TabGroup (types.ts:797)  ← today's split-pane unit (TabGroupLayoutNode, types.ts:751)
             └─ Tab (types.ts:775)   ← terminal | editor | diff | browser | simulator …
```

**Decision: the new "super-tab" and parallel-pane unit is the *Worktree*, not the Project.** Reasons:

- A Project may have many worktrees; "show project A next to project B" is under-specified until you pick a worktree of each. The worktree is the unit that owns a `TabGroupLayoutNode`, PTYs, and a host.
- The same-repo-multiple-clones use case *requires* worktree granularity — two clones are two worktrees.
- The user's mental model still holds: a worktree pane is labeled by its project, and the super-tab strip groups/labels by project. From the user's seat it *looks* like parallel projects.

**Honest statement of the current reality this changes:**

- Today exactly one worktree is visible; the gate is `workspace.id === renderedActiveWorktreeId` (browser-pane analog at `Terminal.tsx:2226-2227`), and all others stay mounted-but-hidden so PTYs and xterm buffers survive switches.
- Today's only parallelism is (a) intra-worktree tab-group splits and (b) the in-renderer floating overlay.
- There is **no project-level tab strip**; the only tab bar is group-level (`TabBar.tsx` inside `TabGroupPanel.tsx`).
- Multi-OS-window is greenfield: one main `BrowserWindow`, plus browser popups only.

**New vocabulary introduced by this design:**

| Term | Meaning |
|---|---|
| **Worktree pane** | One leaf of the new layout tree: a whole worktree (its full `TabGroupSplitLayout`) rendered in a region of the workbench. |
| **Workbench view** | One saved arrangement: a `WorktreeLayoutNode` tree + which leaf is focused. A single-leaf view ≡ today's behavior. |
| **Project super-tab / view tab** | One entry in the `ProjectTabStrip`; activates a workbench view. |
| **Focused worktree** | The one leaf that owns keyboard shortcuts and Sidebar/RightSidebar context. Remains `activeWorktreeId`. |

**Distinction from multi-root (#1099/#7711):** those issues *merge* several repos into one workspace's file/git view (VS Code multi-root). This design does the opposite: each worktree stays a fully independent workspace — own tabs, own git context, own host — and they are *composed visually* side by side. No shared file tree, no merged git state. Do not conflate the two in implementation or naming.

---

## 4. Goals / Non-Goals

### Goals

- G1. Display **2+ worktrees (any mix of projects, repos, hosts) side by side** in one window, with resizable recursive splits.
- G2. A **project super-tab strip** above the workbench to create, name, switch, reorder, and close workbench views.
- G3. **Drag-to-split** at the worktree level (drag a worktree from the Sidebar or the strip onto a workbench edge/zone), reusing the existing dnd-kit split interaction pattern.
- G4. Clear **focus model**: one focused pane at a time; shortcuts, Sidebar selection, and RightSidebar follow it.
- G5. **Session persistence** of views and layouts, restoring across restarts, per host scope (`workspaceSessionsByHostId`, `types.ts:3570`).
- G6. Full **cross-platform + SSH/WSL** correctness.
- G7. Optional (phased): **detach a view into a real OS window** (ties to #7741/#7811).

### Non-Goals

- NG1. Multi-root workspaces (unified file/git view across repos) — explicitly out; see #1099/#7711.
- NG2. Cross-worktree **tab** drag (moving a Tab from worktree A's group into worktree B's group). Each pane keeps its own `TabGroupSplitLayout` DndContext initially; unifying them is a follow-up (see §10 Open Questions).
- NG3. Synchronized scrolling/typing across panes.
- NG4. Changing PTY/agent lifecycle. Agents and PTYs already run independent of visibility (main-process owned); this feature only changes what is *rendered*.
- NG5. Replacing the existing `FloatingTerminalPanel` overlay in this effort (interaction defined in §10).

---

## 5. Requirements

### Functional

- **FR-1.** The workbench can render a recursive binary split of worktree panes (`WorktreeLayoutNode`), minimum 1 leaf, soft cap 4 leaves, hard cap 6 (see NFR-2).
- **FR-2.** Leaves may reference worktrees from **different projects, repos, and hosts**, and multiple worktrees of the **same repo in different physical folders** (distinct worktree ids by construction).
- **FR-3.** A `ProjectTabStrip` above the workbench lists workbench views; exactly one is active. Views support create, activate, close, reorder (drag), and rename. A single-leaf view renders with zero visual/behavioral difference from today's workbench (no pane chrome regression).
- **FR-4.** Entry points to add a second worktree to the view: (a) drag a worktree row from the Sidebar into a workbench edge zone; (b) Sidebar row context menu → "Open to the side"; (c) pane-header split menu; (d) `WorktreeJumpPalette` (Cmd/Ctrl+J) alternate-accept ("open to the side"); (e) strip "+" button.
- **FR-5.** Each split has a draggable ratio handle (same clamp behavior as tab-group splits, `MIN_RATIO 0.15 / MAX_RATIO 0.85`, `TabGroupSplitLayout.tsx:11-12`). Ratios persist.
- **FR-6.** Exactly one pane is focused. Focus follows pointer-down inside a pane; a visible focus indicator marks it. `activeWorktreeId` always equals the focused pane's worktree; Sidebar highlight, RightSidebar content, worktree back/forward history, and `RecentTabSwitcher` follow it.
- **FR-7.** Keyboard: cross-platform per AGENTS.md (Mac → `metaKey`, else `ctrlKey`; labels ⌘/⇧ vs Ctrl+/Shift+; Electron accelerators `CmdOrCtrl`). New bindings (final chords to be validated against the existing shortcut registry): focus next/previous pane; open focused worktree's Cmd+J pick "to the side"; close focused pane (remove leaf, not the worktree); switch view tab N.
- **FR-8.** Closing a pane removes the leaf and collapses the split (sibling absorbs the space, mirroring `mergeGroupIntoSibling` semantics in `tabs.ts`). The worktree itself is untouched (stays mounted-hidden, PTYs live).
- **FR-9.** Session persistence: views, layouts, ratios, active view, and focused leaf are saved in `WorkspaceSessionState` (`types.ts:1036`) and restored on launch. Restore degrades gracefully when a referenced worktree/host no longer exists (drop the leaf, collapse the split; if a view empties, drop the view).
- **FR-10.** A worktree on a disconnected host renders its existing disconnected/reconnect surface inside its pane; the layout slot is preserved.
- **FR-11.** Sidebar single-click on a worktree: in a single-leaf view, behaves exactly as today (switches that leaf). In a multi-pane view, it retargets the **focused pane** to the clicked worktree (the natural generalization: today the whole workbench is one pane).
- **FR-12.** (Phase 4, optional) A view can be detached into a separate OS window and re-docked.

### Non-Functional

- **NFR-1.** No PTY, xterm buffer, or webview state loss when panes are opened, closed, resized, or when views switch. This forbids React reparenting of worktree surfaces (see §7.4).
- **NFR-2.** Performance: N visible panes means N live xterm render loops + N `ResizeObserver`s. Soft cap 4 with a "performance may degrade" affordance beyond; hard cap 6. PTY resize messages debounced (~150 ms trailing) during ratio drags; hidden worktrees keep today's zero-render cost.
- **NFR-3.** All UI uses `docs/STYLEGUIDE.md` tokens from `src/renderer/src/assets/main.css` and shadcn primitives in `src/renderer/src/components/ui/`. No new color values, font sizes, or shadow tiers.
- **NFR-4.** No `max-lines` suppressions; new logic lands in focused modules (§7.7). No vague file names.
- **NFR-5.** Backward compatibility: old sessions (no view state) hydrate into one single-leaf view from persisted `activeWorktreeId` (`types.ts:1040`); new sessions keep writing `activeWorktreeId` so downgrade/rollback is safe.
- **NFR-6.** SSH/WSL: no code path may assume the two panes share a filesystem, git binary, or host. All per-worktree operations already route through the worktree's `hostId`; the layout layer must never introduce a cross-pane operation that assumes a common host.

---

## 6. UX Design

### 6.1 Entry points

| Entry | Interaction | Result |
|---|---|---|
| Sidebar drag | Drag a worktree row from `WorktreeList.tsx` over the workbench; edge zones (left/right/top/bottom halves of the hovered pane) highlight | Drop splits that pane; drop on center retargets it |
| Sidebar context menu | Right-click worktree → **Open to the Side** (submenu: Right / Below) | Splits the focused pane |
| Super-tab "+" | Click "+" in `ProjectTabStrip` | New single-leaf view; opens `WorktreeJumpPalette` to pick its worktree |
| Jump palette | Cmd/Ctrl+J, then **Alt+Enter** (labeled "Open to the Side" in the palette footer, ⌥⏎ on Mac / Alt+Enter elsewhere) | Splits focused pane with the picked worktree |
| Pane header menu | `⋯` menu on the pane header → Split Right / Split Down / Close Pane / Move to New Window (Phase 4) | As named |
| App menu | View → **Split Workbench** (accelerator `CmdOrCtrl+Shift+\`, pending registry audit) | Split focused pane, then palette to pick |

### 6.2 Screen layout — super-tab strip + parallel workbench

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ⋯ titlebar (drag region) ⋯                                                       │
├──────────┬─────────────────────────────────────────────────────────┬───────────┤
│          │ ┌─[orca ⌥ main]──[orca + shop-api ▣]──[experiment]──[+]┐│           │
│ Sidebar  │ └─────────── ProjectTabStrip (workbench views) ────────┘│ Right     │
│          ├────────────────────────────┬────────────────────────────┤ Sidebar   │
│ ▸ Group  │ ● orca · main · ~/dev/orca │ ○ shop-api · feat/cart      │           │
│  ▾ orca  │ ┈┈ WorktreePaneHeader ┈┈┈┈ │ ┈┈┈ (unfocused) ┈┈┈┈┈┈┈┈┈    │ (follows  │
│    main ◀│ ┌─────────┬───┬──────────┐ │ ┌────────────────────────┐  │  focused  │
│    wt-2  │ │terminal │ │ │ editor   │ │ │ terminal (agent run)   │  │  pane =   │
│  ▾ shop  │ │         │ ⇔ │          │ │ │                        │  │  orca/    │
│   cart   │ │ (inner  │ │ │ (inner   │ │ │  $ pnpm test …         │  │  main)    │
│          │ │  tab-   │ │ │  group   │ │ │                        │  │           │
│          │ │  groups)│ │ │  splits) │ │ │                        │  │           │
│          │ └─────────┴───┴──────────┘ │ └────────────────────────┘  │           │
│          │            ◀━━ worktree-level ResizeHandle ━━▶            │           │
└──────────┴────────────────────────────┴────────────────────────────┴───────────┘
  ● = focused pane (header shows focus treatment; Sidebar highlights orca/main)
  ▣ = view-tab badge indicating a multi-pane view; ⌥ = single-pane view
```

- **Strip anatomy:** each view tab shows the project name(s) of its leaves — single-leaf: `project · branch`; multi-pane: `projA + projB` with a split glyph. Overflow scrolls horizontally (same pattern as group-level `TabBar`). The strip is hidden entirely when there is exactly one view with one leaf **and** the user has never created a second view — zero new chrome for users who don't use the feature (a `View → Show Workbench Tabs` toggle forces it on).
- **Pane header (`WorktreePaneHeader`):** slim single row per pane — project name, branch, path disambiguator when two leaves share a repo name (e.g. `orca (~/dev/orca)` vs `orca (~/dev/orca-2)`), host badge for SSH/WSL, and the `⋯` menu. Rendered **only when the view has ≥2 leaves** — single-leaf views keep today's exact chrome.
- **Focus indicator:** the focused pane's header uses the active-surface treatment; unfocused panes get the muted treatment. Use existing border/ring tokens (`--border`, `--ring`, accent foreground tokens per STYLEGUIDE) — the same visual language the group-level focused pane already uses; no new colors.
- **Sidebar:** unchanged structure. Highlight tracks the focused pane's worktree. Worktrees currently visible in the active view get a small "visible" affordance (e.g. the existing dot/eye treatment used for state badges) so users can tell which rows are on screen.
- **RightSidebar:** follows the focused pane, exactly as it follows `activeWorktreeId` today. Clicking into pane B swaps its content to B's worktree.
- **Empty states:** a view with a leaf whose worktree was deleted shows a centered empty-slot card ("Worktree removed — pick another") with a jump-palette button. A brand-new view from "+" opens directly into the palette.
- **Non-terminal `activeView`s** (`ui.ts`: settings/tasks/activity/…): the strip and split layout apply only to the terminal workbench. Switching to Settings replaces the whole center column, exactly as today; returning to terminal restores the active view.

### 6.3 Drag-to-split interaction

```
 Dragging "shop-api / feat-cart" from Sidebar over the right edge of a pane:

┌──────────┬──────────────────────────────────────────────┐
│ Sidebar  │  ┌ pane: orca · main ────────────┬─────────┐  │
│          │  │                               │▒▒▒▒▒▒▒▒▒│  │
│  shop ─┐ │  │        (terminal)             │▒ DROP  ▒│  │
│  cart ○─┼─┼──────▶ ghost row follows cursor │▒ ZONE  ▒│  │
│        └─┼──┘                               │▒(right) ▒│  │
│          │  │                               │▒▒▒▒▒▒▒▒▒│  │
│          │  └───────────────────────────────┴─────────┘  │
└──────────┴──────────────────────────────────────────────┘
 Zones per hovered pane: left/right/top/bottom = split in that direction;
 center = replace this pane's worktree. Highlight reuses the split-preview
 overlay pattern of TabPaneColumnSplitDragOverlay.
```

On drop: `splitWorktreeLeaf(paneLeafPath, direction, draggedWorktreeId)` → new split node at ratio 0.5, dragged worktree becomes focused.

### 6.4 Floating-window detach flow (Phase 4)

```
 Pane header ⋯ → "Move to New Window"

 ┌ Main window ───────────────────────┐      ┌ Floating window ─────────────┐
 │ [orca ▣]  → collapses to single    │      │ ⋯ titlebar ⋯                 │
 │ ┌────────────────────────────────┐ │      │ ┌──────────────────────────┐ │
 │ │ orca · main   (sibling absorbs │ │      │ │ shop-api · feat/cart     │ │
 │ │  the freed space)              │ │  +   │ │ (full worktree surface,  │ │
 │ │                                │ │      │ │  own tab-group splits)   │ │
 │ └────────────────────────────────┘ │      │ └──────────────────────────┘ │
 └────────────────────────────────────┘      │  [⇤ Dock back] in header      │
                                              └──────────────────────────────┘
```

---

### 6.5 Trigger & parent-representation refinements (decided)

**Opening a worktree in parallel — two triggers from the left Sidebar:**

- **Modifier-click a worktree row → instant parallel split**, direction chosen automatically from the *split-target pane's aspect ratio* (this generalizes "the window's aspect ratio" — for the first split the focused pane fills the workbench, so they coincide): a **wide** target splits to the **right** (`direction: 'horizontal'`), a **tall** target splits **below** (`direction: 'vertical'`). Always dividing the longer axis keeps each resulting pane as usable as possible. **Cross-platform (AGENTS.md):** the modifier is **⌘-click on macOS, Ctrl-click on Windows/Linux** — macOS reserves *Ctrl-click* for the context menu, so meta is the correct Mac modifier (the plain phrasing "Ctrl-click" maps to Ctrl only off-Mac). Plain click is unchanged (N=1: switch the single pane, identical to today).
- **Right-click a worktree row → context menu → "Open in Parallel"**, whose primary action mirrors the same aspect-ratio choice, with a submenu offering explicit **Split Right / Split Below**. The label shows the direction it will use (⤷ Right / ⤵ Below).

Both route to `splitActiveWorkbenchPane(focusedWorktreeId, direction, pickedWorktreeId)`. The decision is a pure, unit-tested helper `pickSplitDirection(rect) = rect.width >= rect.height ? 'horizontal' : 'vertical'`, reused by the drag-drop edge/centre logic.

**Parent representation lives in the Sidebar; panes carry only a group indicator (decided).** The Sidebar already *is* the parent representation of each worktree, so panes get **no** parent band and **no** second tab strip. Instead each parallel pane shows a compact **sidebar-group indicator** — the project name plus the sidebar group's color/badge — so you can tell at a glance which sidebar group a pane maps to. It integrates into the pane's existing content `TabBar` as a leading badge, adding no vertical layer, and the focused pane is marked with the existing ring/border tokens. In a single-pane view the indicator is hidden (zero extra chrome). This single-sources the hierarchy in the Sidebar and removes the redundant-tab-layer noise entirely — the reason a vertical two-layer tab representation is unnecessary is precisely that the Sidebar already expresses the parent, and in parallel all that matters per pane is *which sidebar group it is*.

---

### 6.6 Drag-to-split & drag-to-rearrange (VSCode/Cursor-style magnet split) — next phase

Two drag interactions layer on top of the click/menu entry points, giving the spatial "magnet" control users expect from VSCode/Cursor tab drag-split. This is the interaction users find most comfortable, so it is the headline of the next implementation phase.

**A. Sidebar → workbench (enter parallel by dragging a worktree in).**

- Drag a worktree row from `WorktreeList` — one **not currently visible** — over the workbench.
- Each hovered pane surfaces **five drop zones** (VSCode model): **center** (replace this pane's worktree), **left / right** (split `horizontal`, new pane on that side), **top / bottom** (split `vertical`, new pane on that side). A snap/magnet preview overlay highlights the resulting region as the cursor nears an edge, so the split is auto-oriented by where you drop.
- Drop → `splitWorktreePane(targetLeafPath, direction, draggedWorktreeId, placement)` (left/top = `before`, right/bottom = `after`), or `retargetWorktreePane` for center. A first drag from a single view auto-seeds the parallel view (same reseed as `openWorktreeInParallel`).

**B. In parallel view — drag a pane by its label to rearrange.**

- The pane's control-cluster label (§6.5) doubles as a **drag handle**: press-drag the label and drop it onto another pane's edge zone to **move** that pane to a new position/orientation — the "most comfortable" UX the user calls out.
- Drop → `moveWorktreePane(fromWorktreeId, targetLeafPath, direction, placement)`, implemented as a single transaction (`removeLeaf(from)` then `splitLeafAtPath(target, direction, from)`) so the tree never passes through an invalid intermediate; the vacated sibling collapses to fill the space.
- This makes the ⇅ toggle and ✕ close (§6.5) the *quick* controls and drag the *spatial/precise* one — 종/횡 mixes like 종종횡 · 종횡횡 are reachable either way.

**Integration with everything decided so far:**

- **Four entry points, one model.** (1) ⌘/Ctrl-click a sidebar row; (2) right-click → "Open in Parallel"; (3) **drag a sidebar row into a pane zone** (A); (4) **drag a pane label onto a zone** to rearrange (B). (1)(2) are quick/keyboard-friendly; (3)(4) are spatial. All four funnel through the same pure `worktree-layout-tree` ops and the `workbench-views` slice, so behavior, persistence, and the focus/`activeWorktreeId` mirror are identical regardless of route.
- **Sidebar reflects parallel membership (§6.2 / bug B).** Every worktree in the active view shows a muted "in parallel" selection; the focused pane keeps the real highlight. Drag sources/targets and the selection styling read from the same `workbenchVisibleWorktreeIds`.
- **Reuse, don't reinvent.** A worktree-level `useWorktreeDragSplit` mirrors the existing tab-level `useTabDragSplit`, and the drop-zone overlay mirrors `TabPaneColumnSplitDragOverlay`; a distinct dnd-kit drag type (`'worktree-pane'`) keeps it from colliding with in-worktree tab drags.
- **No reparenting (NFR-1).** Drag mutates only the layout tree + slot rects; the flat surface pool re-positions — never remounts — so xterm/webview state survives every rearrange.

**New code this phase needs:** a pure `moveLeaf(tree, fromWorktreeId, targetPath, direction, placement)` op in `worktree-layout-tree.ts` (remove+split as one atomic step); `useWorktreeDragSplit` + a worktree drop-overlay component; making `WorktreeList` rows dnd-kit drag sources and the pane label a drag handle; and the `workbench-views` slice actions `splitWorktreePaneAtPath` / `moveWorktreePane`.

---

## 7. Architecture / Code Design

### 7.1 New shared types (`src/shared/types.ts`)

```ts
/** Worktree-level analog of TabGroupLayoutNode (types.ts:751): leaves are worktrees. */
export type WorktreeLayoutNode =
  | { type: 'leaf'; worktreeId: string }
  | {
      type: 'split'
      direction: 'horizontal' | 'vertical'
      first: WorktreeLayoutNode
      second: WorktreeLayoutNode
      ratio?: number
    }

/** One super-tab in the ProjectTabStrip. */
export type WorkbenchView = {
  id: string                    // durable uuid
  title?: string                // user rename; otherwise derived from leaf projects
  layout: WorktreeLayoutNode
  focusedWorktreeId: string     // must be a leaf of `layout`
}
```

`WorkspaceSessionState` (`types.ts:1036`) gains optional fields (old sessions lack them → legacy hydration path):

```ts
workbenchViews?: WorkbenchView[]
activeWorkbenchViewId?: string
```

`activeWorktreeId` (`types.ts:1040`) **keeps being written** (mirror of the active view's `focusedWorktreeId`) for rollback safety and for the folder-workspace scope logic that already reads it.

### 7.2 Pure tree operations — `src/renderer/src/lib/worktree-layout-tree.ts`

Pure, unit-testable functions over `WorktreeLayoutNode` (mirroring the operations `tabs.ts` performs on `TabGroupLayoutNode`, but extracted rather than embedded in the slice):

`collectLeafWorktreeIds`, `splitLeaf(tree, path, direction, newWorktreeId)`, `removeLeaf(tree, worktreeId)` (sibling collapse), `replaceLeaf`, `setRatioAtPath`, `findLeafPath`. Node paths use the same `'first'/'second'` dot-path convention as `setTabGroupSplitRatio` (`TabGroupSplitLayout.tsx:209`).

> Open refactor (not required): `tabs.ts`'s tree ops could later be re-based on a shared generic `split-layout-tree.ts` parameterized on the leaf payload. Do **not** block Phase 1 on this; duplication of ~80 lines of pure functions is cheaper than destabilizing `tabs.ts`.

### 7.3 New Zustand slice — `src/renderer/src/store/slices/workbench-views.ts`

Joins the existing ~40 slices in `useAppStore` (`store/index.ts:43`).

**State:**

```ts
workbenchViews: WorkbenchView[]          // ordered = strip order
activeWorkbenchViewId: string | null     // null until hydration
```

**Derived selectors** (memoized, in the slice file):

- `selectActiveWorkbenchView(state)`
- `selectVisibleWorktreeIds(state): ReadonlySet<string>` — leaves of the active view when `activeView === 'terminal'`; empty otherwise. **This is the new render gate.**

**Actions:** `activateWorkbenchView`, `createWorkbenchView(worktreeId)`, `closeWorkbenchView`, `renameWorkbenchView`, `reorderWorkbenchViews`, `splitWorktreePane(path, direction, worktreeId)`, `closeWorktreePane(worktreeId)`, `retargetWorktreePane(path, worktreeId)`, `setWorktreePaneRatio(path, ratio)`, `focusWorktreePane(worktreeId)`, `focusAdjacentWorktreePane(dir)`.

**The focus invariant (the crux of coexistence with `activeWorktreeId`):**

Every action that changes the focused leaf **also calls the existing `setActiveWorktree`** (`worktrees.ts:4378`). Conversely, `setActiveWorktree` is wrapped/extended so that when the active view is multi-pane and the target worktree:

- **is a leaf** of the active view → only `focusedWorktreeId` moves (focus jump, no layout change);
- **is not a leaf** → the focused leaf is retargeted to it (FR-11).

This makes `activeWorktreeId` remain the *single* source of truth for "focused worktree." Every existing consumer — `layoutByWorktree`, `groupsByWorktree`, `activeGroupIdByWorktree`, `unifiedTabsByWorktree`, Sidebar highlight, RightSidebar, worktree history, `RecentTabSwitcher`, `WorktreeJumpPalette` — continues to work with **zero changes to its keying**. Per-worktree maps were always keyed by worktreeId, never by "the visible one," so multi-visible costs them nothing.

### 7.4 The render seam in Terminal.tsx — slot-and-pool, not reparenting

Today (`Terminal.tsx:245` builds `workspaceSurfaces`, mapped at `:2074`), all worktree surfaces are absolutely positioned siblings; visibility is `workspace.id === renderedActiveWorktreeId`, others get `hidden` (`:2408-2416`).

**Constraint (NFR-1):** we cannot render surfaces as children of a recursive React split tree, because moving a surface between tree positions reparents its DOM → xterm canvases, `<webview>`s (browser tabs), and editor state would remount/reload. The existing mounted-but-hidden pool exists precisely to avoid this.

**Design: keep the flat pool; the layout tree produces *rects*, not children.**

1. `WorktreeSplitLayout` renders the recursive split structure (headers, resize handles, drop overlays) as a normal React tree, but each leaf renders an **empty slot `<div>`** (plus the `WorktreePaneHeader`), not the surface.
2. A `useWorktreePaneSlotRects` hook observes each slot via `ResizeObserver` and publishes `Map<worktreeId, DOMRectReadOnly>` (relative to the workbench).
3. The existing surface pool changes its per-surface gate from

   ```ts
   // before (Terminal.tsx ~2408): visible = workspace.id === renderedActiveWorktreeId
   // after:
   const rect = paneSlotRects.get(workspace.id)
   const visible = rect !== undefined            // leaf of the active view
   ```

   Visible surfaces get `style={{ position:'absolute', top, left, width, height }}` from their rect; non-visible surfaces keep today's `absolute inset-0 hidden`. The browser-pane visibility analog (`isVisibleWorktree`, `Terminal.tsx:2226-2227`) switches to the same set membership.
4. Ratio drags update rects synchronously (observer fires per frame); xterm `fit` runs on rect change with the debounce from NFR-2 for the PTY-resize IPC.

This is ~30 lines of change at the seam, zero risk to surface internals, and it preserves the documented shortcut-ownership rationale in `TabGroupSplitLayout.tsx:155-159`: `isWorktreeActive` passed into each surface's `TabGroupSplitLayout` (`Terminal.tsx:2423`) stays `worktreeId === activeWorktreeId` — so in a 2-pane view, only the **focused** pane owns Cmd/Ctrl+W and split shortcuts, which is exactly the correct multi-pane behavior, for free.

### 7.5 New components

| File | Responsibility |
|---|---|
| `src/renderer/src/components/workbench/WorktreeSplitLayout.tsx` | Recursive split renderer for `WorktreeLayoutNode`. Structure directly mirrors `SplitNode` (`TabGroupSplitLayout.tsx:114`): leaf → slot + header; split → two flex children + `ResizeHandle` driving `setWorktreePaneRatio`. |
| `src/renderer/src/components/workbench/WorktreePaneHeader.tsx` | Pane chrome: project · branch · path disambiguator · host badge · focus treatment · `⋯` menu (shadcn `DropdownMenu`). |
| `src/renderer/src/components/workbench/ProjectTabStrip.tsx` | The super-tab strip. shadcn primitives; horizontal overflow; drag-reorder via dnd-kit `SortableContext` (same dependency already in use). |
| `src/renderer/src/components/workbench/useWorktreeDragSplit.ts` | dnd-kit wiring for Sidebar-row → pane-zone drops. Modeled on `useTabDragSplit.ts`, but with its **own drag type** (`'worktree-pane'`) so it never collides with tab drags. |
| `src/renderer/src/components/workbench/WorktreePaneDropOverlay.tsx` | Zone highlight during drag, patterned on `TabPaneColumnSplitDragOverlay`. |
| `src/renderer/src/components/workbench/useWorktreePaneSlotRects.ts` | Slot-rect observation (§7.4). |

**Extract, don't fork, `ResizeHandle`:** move it from `TabGroupSplitLayout.tsx:14-112` into `src/renderer/src/components/split-layout/SplitResizeHandle.tsx` (its pointer-capture logic is layout-agnostic; the only coupling is the `onRatioChange` callback) and import it from both layouts. This also shrinks `TabGroupSplitLayout.tsx` toward the max-lines budget instead of growing anything.

**DndContext nesting:** `TabGroupSplitLayout` mounts its own `DndContext` per worktree (`:253`). The worktree-level `DndContext` wraps the whole workbench *outside* those. dnd-kit contexts don't share droppables across boundaries, which is what we want for Phase 1 (NG2): tab drags stay inside their worktree; worktree drags originate in the Sidebar (outside all inner contexts) and target only workbench-level zones.

### 7.6 Modified files (exhaustive for Phases 1–3)

| File | Change |
|---|---|
| `src/shared/types.ts` | `WorktreeLayoutNode`, `WorkbenchView`, `WorkspaceSessionState` fields (§7.1) |
| `src/renderer/src/store/slices/workbench-views.ts` | **new** slice (§7.3) |
| `src/renderer/src/store/index.ts` | register slice |
| `src/renderer/src/store/slices/worktrees.ts` | `setActiveWorktree` gains the focus-vs-retarget branch (§7.3); no other change |
| `src/renderer/src/lib/worktree-layout-tree.ts` | **new** pure tree ops (§7.2) |
| `src/renderer/src/components/Terminal.tsx` | render-gate seam (§7.4); mount `WorktreeSplitLayout` around the surface pool region |
| `src/renderer/src/components/tab-group/TabGroupSplitLayout.tsx` | extract `SplitResizeHandle` (mechanical) |
| `src/renderer/src/App.tsx` | mount `ProjectTabStrip` at the top of the center column (`:2396` region); hydration (`:965-976`) builds views (§7.8) |
| `src/renderer/src/components/sidebar/WorktreeList.tsx` | rows become drag sources; context-menu "Open to the Side"; visible-affordance dot |
| `src/renderer/src/components/WorktreeJumpPalette.tsx` | Alt+Enter "Open to the Side" accept path |
| `src/renderer/src/lib/workspace-session.ts`, `tabs-hydration.ts` | persist/hydrate view state (§7.8) |
| Electron menu (main) | `View → Split Workbench`, `View → Show Workbench Tabs` with `CmdOrCtrl` accelerators |

### 7.7 Keyboard routing

All new shortcuts registered where existing workbench shortcuts live, using the platform check mandated by AGENTS.md (`navigator.userAgent.includes('Mac')` → `metaKey`, else `ctrlKey`), labels ⌘/⌥/⇧ vs Ctrl/Alt/Shift. Candidate chords (must be audited against the current shortcut map before finalizing — flagged as a Phase 2 task, not assumed free):

- `Mod+Shift+\` split focused pane (mirrors common editor conventions)
- `Mod+Alt+ArrowLeft/Right/Up/Down` focus adjacent pane (geometric adjacency from slot rects)
- `Mod+Shift+W` close focused **pane** (distinct from `Mod+W` close tab, which stays gated to the focused worktree per §7.4)

Terminal-focused keystrokes are unaffected: xterm swallows keys per pane; global chords already flow through the `isWorktreeActive`-gated handlers.

### 7.8 Session persistence & hydration

- **Write:** the session patcher includes `workbenchViews` + `activeWorkbenchViewId` on every layout/focus mutation (same debounced channel as `tabGroupLayouts`, `types.ts:1075`). `activeWorktreeId` mirror kept in sync (NFR-5).
- **Hydrate (App.tsx `:965-976` path):**
  1. If `workbenchViews` present → validate each leaf against loaded worktrees + `folderWorkspaces`; drop dead leaves via `removeLeaf`; drop empty views; if none survive, fall through to legacy.
  2. Legacy → synthesize `[{ id, layout: {type:'leaf', worktreeId: activeWorktreeId}, focusedWorktreeId: activeWorktreeId }]`.
- **Per-host scoping:** `workspaceSessionsByHostId` (`types.ts:3570`) already partitions session state per execution host. A view may reference worktrees on *multiple* hosts; store view state in the primary/default session and validate leaves per-host at hydration — a leaf whose host is offline is **kept** with the disconnected surface (FR-10), only leaves whose worktree records are *gone* are dropped.

### 7.9 SSH / multi-host correctness

Nothing in the layout layer touches a filesystem, git binary, or PTY directly — it composes existing per-worktree surfaces, each already bound to its `hostId` connection stack. The requirements are therefore *prohibitions*: no cross-pane operation that assumes shared paths (NFR-6); pane headers must show the host badge so a user is never confused about *where* a terminal runs; capability caches (`GitCapabilityCache`) remain per-host and are untouched.

---

## 8. Floating-Window Option (Phase 4)

Two sub-options:

**(a) In-renderer overlay** (extend today's `FloatingTerminalPanel`, `App.tsx:2507`): cheap, no IPC work — but it cannot leave the `BrowserWindow`, so it fails the primary motivation (second monitor / OS-level window management). It also stacks a *third* layout mechanism on top of the two we'd then have.

**(b) Real second `BrowserWindow`** — **recommended.** Rationale: PTYs, agent processes, git, and host connections all live in the **main process**; a second renderer is "just another subscriber." This is also exactly what #7741 asks for and subsumes the OS-window facet of #7811.

Design sketch:

- `src/main/window/createFloatingViewWindow.ts` — creates a `BrowserWindow` loading the same renderer with `?floatingViewId=<viewId>`; `src/main/window/window-registry.ts` tracks all windows.
- Every `mainWindow.webContents.send(...)` call site becomes a registry **broadcast** (or targeted send where the channel is worktree-scoped). This is the widest-blast-radius change and the reason floating is Phase 4, not Phase 1. `focus-existing-window.ts` (single-instance) focuses the registry's main window.
- The floating renderer boots the same store but renders only `WorktreeSplitLayout` for its pinned view — no Sidebar/RightSidebar (minimal chrome, header shows "Dock back").
- **State authority:** view membership/layout mutations route through main-process-relayed IPC so both windows converge; per-worktree data already flows from main. A worktree may be *visible* in at most one window at a time (moving it detaches it from the main window's view — matching the "Move to New Window" verb, and dodging dual-xterm-attachment questions entirely).
- Honest cost note: the second renderer re-runs hydration and mounts its own xterm instances; scrollback for its worktrees replays from the main-process PTY buffer, same as an app restart does today.

---

## 9. Phased Implementation Plan

| Phase | Scope | Ships value | Rough size |
|---|---|---|---|
| **1 — Parallel core** | `WorktreeLayoutNode` + tree ops + `workbench-views` slice (single implicit view, no strip UI) + Terminal.tsx slot-and-pool seam + `WorktreeSplitLayout`/`WorktreePaneHeader`/extracted `SplitResizeHandle` + "Open to the Side" via Sidebar context menu + focus model + pane close. | 2 worktrees/projects side by side, resizable, correct focus. | ~M-L (1.5–2 wks): ~6 new files, 4 modified; the seam is small but needs careful xterm/webview regression testing |
| **2 — Super-tabs & entry points** | `ProjectTabStrip` (create/switch/close/rename/reorder), Sidebar drag-to-split + drop overlay, Cmd+J Alt+Enter, menu items + accelerators, shortcut-registry audit, soft/hard pane caps. | Full UX surface of the feature. | ~M (1–1.5 wks) |
| **3 — Persistence** | `WorkspaceSessionState` fields, write/hydrate paths, dead-leaf/offline-host degradation, legacy migration, per-host validation. | Views survive restart; rollback-safe. | ~S-M (0.5–1 wk) |
| **4 — Floating windows (optional)** | Window registry, broadcast IPC refactor, `createFloatingViewWindow`, detach/dock verbs, closes #7741 and the OS-window part of #7811. | Second-monitor workflows. | ~L (2–3 wks; IPC broadcast refactor dominates) |

Each phase is independently reviewable; Phases 1–3 have no main-process changes beyond menu items.

---

## 10. Risks, Edge Cases, Open Questions

**Risks**

- **R1 — Resource cost of N visible worktrees.** N xterm render loops + WebGL contexts, N possible `<webview>`s. Mitigations: pane caps (NFR-2), PTY-resize debounce, and the fact that *hidden* worktrees are no more expensive than today. Measure on Windows (weakest GPU-context budget) before raising caps.
- **R2 — The Terminal.tsx seam.** `Terminal.tsx` is large and load-bearing; the gate change is small but a mistake could unmount surfaces. Mitigation: the gate change is a pure superset (`id === active` ⊂ `set.has(id)`); Phase 1 keeps a feature-flag fallback to the single-visible path.
- **R3 — dnd-kit context collisions.** Outer worktree-level drags vs inner per-worktree tab drags. Mitigated by separate contexts + distinct drag types (§7.5); verified by a dedicated interaction test.
- **R4 — Shortcut collisions.** Candidate chords may clash with existing bindings or terminal apps. Phase 2 includes an explicit registry audit; nothing here hard-commits chords.

**Edge cases**

- Same worktree in two panes of one view: **disallowed** (a worktree surface is a singleton DOM subtree; two rects can't both host it). `splitWorktreePane` rejects duplicates; the drop zone shows a "already visible" state.
- Closing/deleting a worktree (or its project) that is a leaf in saved views: run `removeLeaf` across all views; empty views are removed; if the active view dies, activate the neighbor.
- Focused pane's host disconnects: pane shows the existing reconnect surface; focus and shortcuts remain on it (user can still close/retarget the pane).
- Interaction with the existing floating overlay (`FloatingTerminalPanel`): unchanged in Phases 1–3; it floats above whatever the workbench shows. Phase 4 should fold its use cases into real windows and then deprecate — tracked separately.
- `activeView !== 'terminal'`: strip hidden, `selectVisibleWorktreeIds` empty, all surfaces hidden — identical to today.
- Very narrow panes: slot min-width; below it, the resize clamp (0.15/0.85) plus a per-pane `min-w` floor keeps headers legible; inner tab-group layouts already handle narrow widths.

**Open questions**

- **Q1.** Cross-worktree tab drag (move a Tab from pane A into pane B): requires either one unified DndContext or a bridge; deliberately NG2 now. Decide after Phase 2 telemetry (`recordFeatureInteraction`) shows demand.
- **Q2.** Should Sidebar single-click in a multi-pane view retarget the focused pane (FR-11) or focus-if-visible-else-retarget? Proposal implements the latter's first half implicitly (clicking a *visible* worktree's row focuses its pane). Needs a quick usability pass.
- **Q3.** Per-view background differentiation for same-repo clones (beyond the path disambiguator)? A STYLEGUIDE-conforming subtle header tint could help; defer.
- **Q4.** Should a view remember per-leaf `activeGroupIdByWorktree` snapshots, or is the global per-worktree map (current behavior) sufficient? Proposal: global map is sufficient — a worktree has one "current group" no matter which view shows it.

---

## 11. Test Plan

**Unit (vitest)**

- `worktree-layout-tree.ts`: split/remove/replace/ratio/path ops, sibling collapse, duplicate-leaf rejection, deep-tree paths.
- `workbench-views` slice: every action; the `setActiveWorktree` focus-vs-retarget branch; invariant "focusedWorktreeId ∈ leaves" after every action; view lifecycle (create/close/reorder); dead-leaf pruning.
- Hydration: legacy session → synthesized single-leaf view; corrupted/partial view state degradation; offline-host leaf retention vs deleted-worktree leaf drop; `activeWorktreeId` mirror consistency.

**Component (renderer)**

- `WorktreeSplitLayout`: renders correct slot structure for leaf/split trees; ratio drag calls `setWorktreePaneRatio` with correct path (mirror the existing `TabGroupSplitLayout` tests); slot rects publish on resize.
- Surface pool gate: with a 2-leaf view, both surfaces get rects and lose `hidden`; a third mounted worktree stays hidden; switching views never unmounts any surface (assert stable React keys / DOM node identity).
- `ProjectTabStrip`: create/switch/close/rename/reorder; strip auto-hide rule.
- dnd: Sidebar row drag over each zone produces the right split action; tab drags inside a pane are unaffected while a second pane exists (R3).

**Manual / cross-platform matrix**

- macOS, Windows, Linux: all new shortcuts fire with the right modifier and display the right labels; menu accelerators (`CmdOrCtrl`) work; ratio drag at high-DPI.
- SSH + WSL: one local pane + one SSH pane side by side — terminal I/O, git status, agent run in both; disconnect the SSH host mid-session and verify the pane's reconnect surface + layout stability; restart Orca and verify restore with the host still offline.
- Same-repo clones: two clones of one repo side by side; verify header disambiguation and that git operations in each pane hit the correct folder.
- Performance spot-check: 4 panes each running a scrolling agent session on Windows (R1); ratio-drag smoothness; PTY resize debounce (no resize storm in `tmux`/full-screen TUIs).
- Regression: single-leaf view is pixel- and behavior-identical to pre-feature builds (chrome, shortcuts, floating overlay, `RecentTabSwitcher`, worktree history, session restore).
