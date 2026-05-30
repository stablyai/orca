# Layout rules — design doc

**Status:** draft / WIP — local only.
**Issue:** [#1499](https://github.com/stablyai/orca/issues/1499)
**Branch:** `feat/layout-rules`

## Problem (1-paragraph)

Multi-pane workflows where content kinds (editor / terminal / browser) live in fixed regions of the workspace today require manual drag-and-drop on first session. Setup scripts in `orca.yaml`, CLI automation (`orca terminal create`, `orca tab create`), and multi-developer repos can't express "this terminal goes bottom-left, this browser tab goes right" — every new entity lands in `activeGroupIdByWorktree`, i.e. wherever the user happens to be focused. Detailed motivation in #1499.

## Goals

1. **Declarative shape in `orca.yaml`** — a `layout` block describing named groups, their positions, and rules mapping content kinds to groups.
2. **CLI overrides** — `--group <name>` on `orca terminal create` / `orca tab create`.
3. **First-mount materialization** — fresh worktree opens with the declared layout already built; no manual reshuffle.
4. **Backward compat** — repos without `orca.yaml layout` keep current behavior bit-for-bit.

## Non-goals (this iteration)

- Dynamic layout editing via CLI (`orca layout add-group ...`) — manual drag-drop in UI stays the primary editing surface.
- Cross-worktree shared layouts — every worktree resolves its own `orca.yaml`.
- Layout rules for non-content entities (sidekick overlay, settings tab) — stays terminal/browser/editor scope.

## Schema

```yaml
layout:
  groups:
    editor:
      position: left-top
    terminal:
      position: left-bottom
    browser:
      position: right
  rules:
    new-editor-tab:  editor
    new-terminal:    terminal
    new-browser-tab: browser
```

### Group definition

| Field | Type | Required | Notes |
|---|---|---|---|
| `position` | `'left-top' \| 'left-bottom' \| 'right-top' \| 'right-bottom' \| 'left' \| 'right' \| 'top' \| 'bottom' \| 'center'` | yes | Region anchor in 2D layout |

`position` is a high-level anchor, not coordinates. Materialization translates it into the existing `layoutByWorktree` split tree using `createEmptySplitGroup` calls. Two-axis anchors (`left-top` etc.) compose horizontal-then-vertical splits; single-axis anchors (`left`, `right`, `top`, `bottom`) split once. `center` means root group (no split).

### Rules

| Key | Maps to | Effect |
|---|---|---|
| `new-editor-tab` | group name | Editor opens (file click, etc.) land in this group |
| `new-terminal` | group name | `orca terminal create` (without `--group`) lands here |
| `new-browser-tab` | group name | `orca tab create` (without `--group`) lands here |

Resolution priority: **explicit `--group` > rule for content kind > current `activeGroupIdByWorktree` fallback** (today's behavior).

Unknown rule key → ignored with warning. Rule pointing at undeclared group name → validation error at parse time.

## CLI surface

```
orca terminal create [--worktree <sel>] [--command <cmd>] [--group <name>]
orca tab create      [--worktree <sel>] [--url <url>] [--profile <id>] [--group <name>]
```

`--group` is a string. Resolved against `orca.yaml layout.groups` in main process. Group not found → error with the list of declared group names. Group found → its UUID is passed through RPC as `targetGroupId`, eventually reaching `createTab`/`createBrowserTab` in renderer.

No `--group` on `orca editor open` (no such CLI exists today). Editor flow is renderer-internal — `openFile()` reads orca.yaml layout state directly.

## Materialization model

Two execution points:

### 1. First-mount seeding (per-worktree, idempotent)

When a worktree is activated for the first time *and* its `groupsByWorktree[worktreeId]` is empty *and* `orca.yaml layout.groups` is non-empty:

1. Compute split tree from declared `position`s (algorithm: see "Position resolution" below).
2. Create groups by calling `ensureGroup` once for the root, then `createEmptySplitGroup` for each additional region.
3. Set `activeGroupIdByWorktree[worktreeId]` to the group named by `rules['new-terminal']` (or first group if no rule), so `ensureWorktreeHasInitialTerminal`'s default `createTab` lands the initial terminal in the right region.

Idempotent: if persisted state already has groups, skip seeding entirely. User's manual rearrangements survive.

### 2. Per-creation rule lookup

When `createTab` / `createBrowserTab` / `openFile` runs:

1. If caller passed `targetGroupId` explicitly → use it (today's behavior).
2. Else: look up `orca.yaml layout.rules` for the content kind. Resolve rule's group name → group UUID → use as `targetGroupId`.
3. Else: fall back to `activeGroupIdByWorktree[worktreeId]` (today's behavior).

This is the single change at three hook sites:
- `src/renderer/src/store/slices/terminals.ts:357-365` — `createTab` resolution
- `src/renderer/src/store/slices/browser.ts createBrowserTab` — browser workspace creation (called from `useIpcEvents.ts:441`)
- `src/renderer/src/store/slices/editor.ts:462` — `openFile` resolution

A pure helper `resolveTargetGroup(state, worktreeId, contentKind, explicit)` lives in `tab-group-state.ts` and is the single source of truth.

## Position resolution algorithm

Maps `position` strings → split tree commands. Algorithm:

1. Bucket groups by horizontal axis: `left-*` → left, `right-*` → right, `top` → root above, `bottom` → root below, `center` → root.
2. Walk in a deterministic order (left → right → top → bottom → center), building tree:
   - `center` first (root).
   - `left-top` + `left-bottom` → split root horizontally (left), then split left vertically (top + bottom).
   - Single-axis anchors (`left`, `right`, `top`, `bottom`) → one split each.

Edge cases:
- One group only (e.g. just `editor: { position: center }`) → root group, no splits.
- Two groups same anchor → second wins, first warned (config error: ambiguous).
- Missing required group ref in rules → parse-time error.

Concrete walkthrough for the canonical layout from #1499:

```yaml
groups: { editor: left-top, terminal: left-bottom, browser: right }
```

→
1. Root group = arbitrary first group, say `editor` (UUID-A) — leaf.
2. `browser: right` → `createEmptySplitGroup(wt, A, 'right')` → group B, layout becomes horizontal split (A left, B right).
3. `terminal: left-bottom` → `createEmptySplitGroup(wt, A, 'down')` → group C, layout becomes nested: top-A + bottom-C on left, B on right.

Result matches the picture in #1499.

## Schema implementation

- New file `src/shared/orca-yaml-layout.ts`: Zod schema for `layout` block + TS types.
- Add `yaml` package to dependencies (proper YAML 1.2 parsing). Layout block is structural — line-by-line parser like `parseOrcaYaml` is fragile for nested mappings.
- New function in `src/main/hooks.ts`: `loadLayoutConfig(repoPath): LayoutConfig | null`. Reads orca.yaml, parses with `yaml`, extracts `layout` key, validates via Zod, returns null if absent or invalid.
- Add `'layout'` to `RECOGNIZED_ORCA_YAML_KEYS` so `hasUnrecognizedOrcaYamlKeys` doesn't false-positive.
- Legacy `parseOrcaYaml` for `scripts` / `issueCommand` stays untouched — no regression risk.

## Renderer plumbing

- New util `src/renderer/src/lib/layout-rules.ts` with:
  - `resolveTargetGroup(state, worktreeId, kind, explicit)` — pure, called from 3 hook sites.
  - `seedWorktreeLayout(state, worktreeId, config)` — used at first-mount.
- Hook site changes are **single-line**: replace fallback `s.activeGroupIdByWorktree[worktreeId]` with a call to `resolveTargetGroup`.
- `worktree-activation.ts:147` (`ensureWorktreeHasInitialTerminal`) gets a pre-step: if `groupsByWorktree[worktreeId]` empty AND layout config present, seed groups before creating the initial terminal.

## CLI plumbing

Pattern from #1498 (`tab switch --focus`):

- Add `'group'` to `allowedFlags` in CLI specs (`src/cli/specs/browser-basic.ts` for `tab create`, `src/cli/specs/terminal.ts` if exists for `terminal create`).
- Conditional spread in handler: only add `groupName` to RPC payload when `--group` is present, so existing test fixtures and automation calls stay byte-identical.
- RPC schema: add optional `groupName: z.string()` to `TabCreate` and terminal create schemas.
- Main runtime: resolve `groupName` → UUID via orca.yaml layout config (or pass as-is to renderer if rules will resolve there — TBD during impl).

## Persistence

The materialized layout (groups + split tree) lives in `groupsByWorktree`/`layoutByWorktree`. Once seeded, persisted Zustand state survives Orca restarts. So:

- First Orca open of a fresh worktree → seed from yaml.
- Every subsequent open → use persisted state, ignore yaml seeds (rules still apply at create time).
- Yaml change after seeding → does NOT re-shuffle existing groups. User explicit re-seed via future `orca layout reset` command (out of scope).

## Backward compatibility

- Repos without `orca.yaml`, or `orca.yaml` without `layout` key → `loadLayoutConfig` returns null → all hook sites fall through to current behavior. Zero behavior change.
- Repos with `orca.yaml layout` deployed to old Orca that doesn't understand it → `hasUnrecognizedOrcaYamlKeys` returns true → "Unknown key in orca.yaml" UI prompt (as today). Until users update Orca, layout is ignored — no crash.

## Open questions / risks

1. **`yaml` package size** — adds ~500 KB to the bundle. Counterargument: the structural parsing it enables is worth it; future config keys benefit too. Alternative: write a tighter manual parser for `layout` block (uglier, fragile).
2. **`createEmptySplitGroup` returns null on failure** — need to handle in `seedWorktreeLayout` (degrade to single root group + log).
3. **`activeGroupIdByWorktree` semantics after seeding** — does `setActiveGroup` happen automatically when user clicks into a group, or do we need to wire something? Verify in live test.
4. **Cross-platform paths** — `loadLayoutConfig(repoPath)` uses Node `fs/path` which is platform-neutral (already used by `loadHooks`). No issue.
5. **Interaction with `orca worktree create --setup`** — setup script runs in the seeded `terminal` group. Verify in live test that `scripts.setup` lands in the right region post-seed.

## Test plan

1. **Schema parsing** (vitest): Zod accepts canonical config; rejects unknown position; rejects rule pointing at undeclared group.
2. **Position algorithm** (vitest): canonical 3-group layout produces expected split tree.
3. **`resolveTargetGroup`** (vitest): explicit > rule > active-group fallback; rule for unknown content kind returns active-group.
4. **`seedWorktreeLayout`** (vitest): empty state + config → groups + layout tree match expectations.
5. **CLI handler** (vitest): `--group` passes through; absent `--group` keeps payload byte-identical (regression test for existing fixtures).
6. **Live integration** (`pnpm dev` against this branch):
   - Drop sample orca.yaml in fresh worktree, verify three groups appear in correct regions on first activation.
   - `orca tab create --url X` (no `--group`) lands in browser group per rule.
   - `orca terminal create --command Y` lands in terminal group per rule.
   - `orca terminal create --group editor` overrides to editor region.
   - Drag a tab manually to a different group; close + reopen worktree; confirm manual layout persists (yaml not re-applied).

## Out of scope (followup tickets)

- `orca layout reset` CLI verb.
- `orca layout show` for inspecting current layout vs declared.
- Per-developer overrides via `.orca/layout-overrides.yaml` (private, not committed).
- Layout rules for sidekick / settings panes.
