# Resource Usage popover: merge Resources + Sessions into one view

## Problem

The status-bar Resource Usage popover currently has two tabs:

- **Resources** — per-worktree CPU/memory grouped by repo, sourced from
  `MemorySnapshot.worktrees`. Local PTYs only (SSH excluded by design at
  `src/main/ipc/pty.ts:832` because remote process trees are not visible
  to the local `ps`/`wmic` sweep).
- **Sessions** — flat list of every PTY the daemon tracks (local **and**
  SSH), sourced from `pty.listSessions()`. Adds tab-binding info, click-
  to-navigate, kill-X per row, and "Kill N orphans".

The data sources only partially overlap: Sessions can show worktrees
(e.g. `orca/Porpoise`, `orca/Stingray`) that never appear in Resources
because they're SSH-backed. Users see this as a confusing inconsistency
between two adjacent tabs in the same popover.

The user wants one unified view that:

1. Lists every PTY the daemon knows about (the union, not the
   intersection).
2. Shows CPU/memory **when available** (i.e. for local PTYs) and `—` for
   remote ones, rather than silently dropping remote sessions.
3. Keeps tab-binding affordances (click row → navigate, kill X with
   confirm dialog) on every row.
4. Surfaces orphans (PTYs not bound to any tab) with the "Kill N
   orphans" bulk action.

## Direction (already decided by user)

> Merge into one tab, drop the switcher entirely.

Out of scope:

- Adding new IPC. The merge uses **only** the data already available:
  `MemorySnapshot` and `pty.listSessions()`.
- Changing what the memory collector tracks. SSH PTYs remain unsampled.
  The unified view simply shows them with empty metric cells instead of
  hiding them.
- Adding new actions (e.g. "stop all in repo", per-repo restart, etc.).
  The exact action set today (kill one with confirm, kill orphans, sleep
  worktree, restart daemon, kill-all-sessions) is preserved.

## Data model

### Inputs

- `snapshot: MemorySnapshot | null` — local-only CPU/Mem data, grouped
  by `worktreeId`. May be `null` while the daemon is unreachable.
- `sessions: DaemonSession[]` — every PTY id the daemon knows, with
  `cwd`, `title`, and a sticky `isAlive`-equivalent.
- `tabsByWorktree`, `ptyIdsByTabId`, `runtimePaneTitlesByTabId`,
  `workspaceSessionReady` — store-side context used to (a) compute
  bound/orphan and (b) resolve human labels.

### Output: a renderer-local view model

The merge produces a renderer-local view-model — **not** a widening of
the shared `WorktreeMemory` shape. `src/shared/types.ts` and the
collector are untouched. New types live next to the merge helper:

```ts
// src/renderer/src/components/status-bar/unifiedRow.ts
type Metric = number | null  // null === "no local sample" (e.g. SSH)

type UnifiedSessionRow = {
  sessionId: string
  label: string
  bound: boolean
  tabId: string | null
  cpu: Metric
  memory: Metric
  hasLocalSamples: boolean
}

type UnifiedWorktreeRow = {
  worktreeId: string
  worktreeName: string
  repoId: string
  repoName: string
  cpu: Metric
  memory: Metric
  history: number[]          // empty when hasLocalSamples is false
  hasLocalSamples: boolean
  sessions: UnifiedSessionRow[]
}

type UnifiedRepoGroup = {
  repoId: string
  repoName: string
  cpu: Metric                // null if every child has hasLocalSamples false
  memory: Metric
  hasRemoteChildren: boolean // drives the "· remote" badge on the row
  worktrees: UnifiedWorktreeRow[]
}
```

A small adapter inside `mergeSnapshotAndSessions` converts each
`WorktreeMemory` from the shared type into a `UnifiedWorktreeRow` with
numeric metrics and `hasLocalSamples: true`. Synthetic remote rows are
constructed directly with `null` metrics. The existing `MetricPair` and
`Sparkline` callsites in the popover get a thin wrapper that renders
`—` when its input is `null`; nothing in `src/shared/` or `src/main/`
changes.

### Merge algorithm

The merge is renderer-only and pure. Inputs in priority order:

- **Snapshot first.** `snapshot.worktrees` is the authoritative source
  for any local PTY's CPU/Mem and for the worktree's identity (it
  already carries `worktreeId`, `worktreeName`, `repoId`, `repoName`,
  and a `sessions[]` array with per-session metrics).
- **Sessions augments.** `sessions: DaemonSession[]` is the union over
  the snapshot — it adds (a) SSH PTYs that the local memory collector
  cannot see and (b) any local PTY that registered too late to make
  this snapshot's sweep.

#### Join key (snapshot session ↔ daemon session)

Both layers identify a session by the **same string**: the PTY id.

- `SessionMemory.sessionId` (collector) is `pty.sessionId ?? pty.ptyId`
  from `pty-registry.ts`. In-process local PTYs spawn with
  `args.sessionId === undefined` (`pty.ts:684`), so the registry stores
  `sessionId: null` and the fallback `pty.ptyId` is used — which equals
  `result.id` from the local provider's spawn, which is also what
  `LocalPtyProvider.listProcesses()` returns as `id`
  (`local-pty-provider.ts:518-522`).
- For daemon-hosted spawns, `mintPtySessionId(worktreeId)` produces the
  `${worktreeId}@@${shortUuid}` form
  (`src/main/daemon/pty-session-id.ts`); both the registry and
  `pty.listSessions()` carry that exact string as the id.

Therefore the dedup key is simply `session.id` on both sides. The
merge MUST build `Set<string>` of all `SessionMemory.sessionId`s from
the snapshot and skip any `DaemonSession` whose `id` is already in the
set (so a local session never appears twice — once with metrics, once
as a `—` placeholder).

#### Worktree resolution for `DaemonSession`s

When a `DaemonSession` is **not** already accounted for by the
snapshot, we need to bucket it under a worktree group. Try in order:

1. **Tab-store walk** (existing logic in `SessionsTabPanel`): look up
   `ptyIdsByTabId` → `tabId` → `tabsByWorktree` → `worktreeId`. This
   resolves any session bound to a live tab in *this* renderer.
2. **Session-id parse**: if the id contains `@@`, take
   `id.slice(0, id.lastIndexOf('@@'))` as a candidate `worktreeId`.
   This is the convention enforced by `mintPtySessionId` (see
   `pty-session-id.ts:5-7` and the symmetric parser in
   `daemon-pty-adapter.ts:328-331`). It correctly recovers the
   worktreeId for SSH sessions that haven't been bound to a tab in
   this Orca instance — which is the user's primary scenario
   (`orca/Stingray`, `orca/Sawfish`, etc.).
3. **Unattributed**: if neither resolves, bucket under a synthetic
   `unattributed` repo group at the bottom of the list.

The `repoId` for each new worktree group is recovered the same way the
collector does it (`collector.ts:resolveWorktreeNames`): split the
worktreeId on the first `::`. Resolved repo display name comes from
the renderer-side store (`store.repos[repoId]?.displayName`) when
available; otherwise the bare `repoId` is used.

#### Step-by-step

1. Initialize `repos: Map<repoId, UnifiedRepoGroup>` empty.
2. Insert all `snapshot.worktrees` (if any) into the map, grouped by
   their `repoId`. Each worktree carries `hasLocalSamples: true` and
   numeric metrics; its sessions inherit numeric metrics.
3. Build `seenSessionIds = new Set<string>(...all session ids in
   snapshot.worktrees[].sessions)`.
4. For each `DaemonSession` in `sessions: DaemonSession[]`:
   - If `seenSessionIds.has(session.id)`, skip (already merged from
     snapshot).
   - Resolve `worktreeId` per the three-step rule above.
   - If the resolved `worktreeId` is already a worktree group in the
     map, append the session to its `sessions[]` with `cpu: null`,
     `memory: null`, `hasLocalSamples: false`. (Reachable for SSH
     sessions whose worktree happens to match a locally-active
     worktree id — rare but possible.)
   - Otherwise, create a new worktree group with `cpu: null`,
     `memory: null`, `history: []`, `hasLocalSamples: false`, and
     append the session.
5. Compute per-repo aggregates: sum `cpu`/`memory` from worktrees with
   `hasLocalSamples === true`. If the repo has *any* worktree with
   `hasLocalSamples === false`, set `repoHasRemoteChildren: true` (used
   by the UI to render a `· remote` badge on the repo header so the
   user knows the displayed totals exclude remote worktrees).
6. The Orca app section (Main / Renderer / Other) renders unchanged
   below the list.

The whole pass is O(W + S) where W = snapshot worktrees and S =
sessions. No nested scans.

### Why this is safe with current data

- Every existing local session continues to render with the same
  numbers. The merge **adds** rows; it does not change values.
- The snapshot rebuilds every poll (10s), so SSH sessions transitioning
  to local (or vice versa) flip representation on the next tick. No
  reconciliation logic needed.
- Orphan detection still works: a session is "bound" iff its
  `sessionId` appears in `boundPtyIds`. Sessions in repos we couldn't
  resolve still get the X-kill affordance.

## UI

### Trigger (status-bar badge) — unchanged

Mac/Linux/Windows safe (no platform-specific glyphs introduced).

### Popover — single panel, fixed height

```
┌─────────────────────────────────────────────────────────────┐
│  Resource Usage                          ⟳   🗑  ✕         │ ← header
├─────────────────────────────────────────────────────────────┤
│  1.9% · 955.2 MB · 3% of system RAM                         │ ← summary
├─────────────────────────────────────────────────────────────┤
│  Name                                       CPU   Memory  · │ ← sort row
├─────────────────────────────────────────────────────────────┤
│  ▾ Triton                                   0.0%  125.5 MB │
│      Terminal 1                             0.0%   63.2 MB ✕│
│      Terminal 1                             0.0%    1.3 MB ✕│
│  ▾ Stingray              ⓘ remote            —      —       │
│      orca/Stingray                          —      —      ✕│
│  ▾ Sawfish               ⓘ remote            —      —       │
│      orca/Sawfish                           —      —      ✕│
│  ─────────────────────────                                  │
│  ▸ Orca app                                 0.5%  829.7 MB │
└─────────────────────────────────────────────────────────────┘
                        ↑ fixed 420px body, owns its own scroll
                        ↓ orphan bulk-kill pill renders here when N>0
```

The header keeps the icon-only **Restart daemon** (RotateCw) and
**Kill all sessions** (Trash2) buttons in the top-right.

### Interaction states (4 paths)

| Scenario                    | Resource cells | Kill X      | Click row    |
|-----------------------------|----------------|-------------|--------------|
| Local PTY, bound            | numeric        | hover only  | navigates    |
| Local PTY, orphan           | numeric        | always      | no-op        |
| Remote PTY, bound           | `—`            | hover only  | navigates    |
| Remote PTY, orphan          | `—`            | always      | no-op        |

`—` is rendered as `text-muted-foreground/50`. The worktree row carries
a small `· remote` badge when `hasLocalSamples === false`; the repo row
carries the same badge when `hasRemoteChildren === true` (so users
know the displayed repo totals exclude remote worktrees).

**`bound` semantics are unchanged from today:** a session is bound iff
`boundPtyIds.has(session.id)` evaluated against this renderer's
`ptyIdsByTabId`. SSH sessions bound to tabs in *another* Orca process
look identical to local orphans here — same as before the merge.

### Empty / loading / error states

- Daemon unreachable → existing banner remains, body shows nothing.
- Sessions error AND no snapshot AND zero sessions → "Resource data
  unavailable. Restart daemon."
- Snapshot present but zero worktrees AND zero sessions → "Nothing
  running right now."
- Loading (no snapshot, no error) → "Loading…".

### Sort

Three buttons in the sort row: **Name**, **CPU**, **Memory**. CPU/Mem
sort puts `null` metrics last (stable). Name uses `localeCompare`.
Selection is repo-group aware: sorting by CPU sorts repos by aggregate
CPU and worktrees within a repo by their CPU.

### Confirm dialogs (unchanged)

- Per-row kill X: confirm Dialog with copy "Kill this session? Force-
  quits `<id>`. Any unsaved work in that pane is lost. This can't be
  undone."
- Header Trash2: existing "Kill all sessions" Dialog from
  `useDaemonActions`.
- Header RotateCw: existing "Restart daemon" Dialog from
  `useDaemonActions`.
- Worktree-level Sleep / Delete: unchanged.

## Implementation plan

1. **New helper** `mergeSnapshotAndSessions.ts` (renderer-side, pure
   function) that takes `(snapshot, sessions, storeContext)` and
   returns the unified `RepoGroup[]` shape above. Unit-testable.
2. **Refactor `ResourceUsageStatusSegment.tsx`**:
   - Remove the tab switcher (drop `activeTab` state, both
     `'resources'` / `'sessions'` branches, the inline pill component,
     and the `Trash2` import for the old switcher).
   - Replace the body with a single render path that consumes the
     unified `RepoGroup[]` from the helper.
   - Keep the existing `WorktreeSection`/`AppSection` patterns — extend
     them to render `null` metrics as `—` and to render the kill-X on
     each session row (with bound-vs-orphan visibility rule).
   - Promote `killConfirm` state and the confirm Dialog from
     `SessionsTabPanel` to the segment level since there's only one
     panel now.
   - Keep `onSessionsChanged` plumbing — call it from kill / kill-
     orphans handlers to trigger an immediate `refreshSessions()`.
   - Delete the now-unused `SessionsTabPanel` component.
3. **Wire metric formatting** to render `—` when metric is `null`. Use
   the `null`-vs-`0` distinction already present in the data model;
   don't conflate them.
4. **Migration**: status-bar item id stays `'resource-usage'`. The
   `migrateStatusBarItems` helper is unchanged. No persistence
   migration needed for this UI-only change.

## Testing

- Unit: `mergeSnapshotAndSessions` with synthetic inputs covering:
  - All 4 interaction-state paths (local-bound, local-orphan,
    remote-bound, remote-orphan).
  - **Dedup**: a local session that appears in both the snapshot and
    the daemon list is rendered exactly once with numeric metrics.
  - **`@@` parse**: an SSH session id `repoX::/path/wtA@@abcd` with no
    matching tab resolves to repoId `repoX`, worktreeId
    `repoX::/path/wtA`.
  - **Tab walk wins over `@@` parse**: a session bound to a tab whose
    worktreeId differs from the `@@` prefix uses the tab's worktreeId
    (defensive against id-format drift).
  - **Repo aggregate excludes remote children**: a repo with one
    local (125 MB) and one remote (`null`) worktree reports
    `cpu/memory = 125 MB` and `hasRemoteChildren = true`.
  - Edge cases: snapshot null, sessions empty, both empty, sessionId
    without `@@` and no tab match → falls into Unattributed.
- Manual:
  - Open with mixed local + SSH worktrees → both render, SSH rows show
    `—` and a `· remote` badge on their worktree and repo headers.
  - Kill a remote session via the X → confirm dialog → optimistic
    removal so row disappears immediately (does not wait 10s).
  - Kill all (header trash) → orphans gone, bound sessions remain.
  - Resize window / scroll the body → fixed 420px holds, no reflow.
  - Accessibility: tab through rows → kill X focusable; after kill
    confirm, focus lands back on the popover content root, not on
    `<body>`. Dialog is keyboard-dismissable except while in-flight.

## Risks & mitigations

- **Risk**: SSH worktrees the user never opened locally still appear in
  Resources (potentially noisy if the daemon retains many idle SSH
  sessions). **Mitigation**: bucketing under a `· remote` badge keeps
  them visually distinct from local-active groups; sort-by-memory pushes
  them to the bottom. If noise becomes a real complaint, a future PR
  can add a "hide remote" toggle.
- **Risk**: Some sessions can't be resolved to any worktreeId (e.g.
  daemon-internal sessions whose ids don't follow the `@@` convention,
  or sessions whose worktreeId resolves to a repo store doesn't know
  about). **Mitigation**: synthetic `Unattributed` repo group at the
  bottom, which already exists in spirit as `ORPHAN_WORKTREE_ID` in the
  memory collector.
- **Risk**: Kill-X on a remote session fires `pty.kill(id)`, which the
  IPC layer routes through `ptyOwnership` to the right SSH provider.
  Behavior is identical to the old Sessions tab — no new failure mode.
- **Risk: poll-rate skew between snapshot (2s) and sessions (10s).**
  After killing an SSH session, the daemon-side `sessions` list can
  retain the dead row for up to 10s while the snapshot has already
  moved on; conversely a freshly-spawned local PTY shows up in
  `sessions` first and is rendered as a remote placeholder for up to
  2s before the next snapshot promotes it.
  **Mitigation**: per-row kill optimistically removes the session id
  from the renderer's local `sessions` state immediately after the IPC
  resolves (in addition to calling `onSessionsChanged()`), so the
  killed row never lingers on screen. The new-session-flash is
  bounded by `POLL_MS` and acceptable.
- **Risk: focus dropped to `<body>` after kill confirm.** When the
  killed session disappears on the next refresh, the per-row X that
  had focus is unmounted. With the confirm Dialog now mounted at the
  segment level, this regression is more visible.
  **Mitigation**: after `runKillConfirmed` resolves, focus the
  popover's content root via a stable ref so keyboard users land back
  in the list, not on `<body>`.

## Non-goals

- No new IPC.
- No collector changes.
- No new persisted UI prefs (the per-tab visibility split is gone, not
  replaced with a per-section toggle).
- No remote memory sampling — that's a separate, much bigger project.
