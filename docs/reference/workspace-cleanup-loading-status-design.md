# Workspace Cleanup Loading Status

## Problem

The inactive workspace cleanup dialog currently rotates through loading messages while
`workspaceCleanup.scan(...)` is still pending. One message says "Protecting active
work" and "Skipping workspaces with open tabs, terminals, live agents, or
unavailable remotes." Because that message loops before any result is available,
the UI implies Orca repeatedly completed a concrete skip/protection step. That is
misleading when the renderer only knows that a broad scan is in flight.

## Goal

Show one honest loading note while inactive workspace cleanup is scanning. The note
should describe the actual safety work that may be taking time, without presenting
fake phase progress or concrete findings.

## Relevant Code

- `src/renderer/src/components/workspace-cleanup/WorkspaceCleanupDialog.tsx`
  renders the cleanup dialog loading banner and currently owns the rotating
  loading copy.
- `src/renderer/src/store/slices/workspace-cleanup.ts` exposes
  `workspaceCleanupLoading` as a boolean and enriches final candidates with
  local renderer state such as tabs, terminals, live agents, dirty editor buffers,
  and recent visible context.
- `src/main/ipc/workspace-cleanup.ts` performs the backend scan by listing repo
  worktrees, filtering inactive workspaces, and reading git evidence. It returns
  one final `WorkspaceCleanupScanResult`.
- `src/shared/workspace-cleanup.ts` defines `WorkspaceCleanupScanResult`, which
  currently contains `scannedAt`, `candidates`, and `errors`; it does not contain
  incremental progress data.
- `docs/STYLEGUIDE.md` says long or multi-step operations may use stage labels or
  progress, but the feedback must match what the app actually knows.

## Proposed Design

Replace the rotating `SCAN_LOADING_STEPS` array and interval state with a single
static loading status:

- Title: `Checking workspace safety`
- Detail: `Scanning worktrees and git state, then combining open tab,
  terminal, live agent, and remote availability signals before suggesting
  deletions.`

The loading banner should keep the existing layout, spinner, color tokens, and
typography. The change should remove the interval and any now-unused
`loadingStepIndex` state.

Do not add numeric progress in this change. The existing IPC API does not expose
checked counts, totals, current repo, current worktree, or current phase. Adding
honest progress would require a separate progress event API and is intentionally
out of scope.

Do not add a new loading-delay state in this change. The dialog already has an
initial loading surface and skeleton rows; the product problem being fixed here is
the dishonest rotating copy, not fast-scan flicker. If flicker becomes the next
problem, it should be handled as a separate timing change across the dialog's
loading states.

## Alternatives Considered

- Generic copy such as `Scanning inactive workspaces...`: safest against
  over-claiming, but less helpful for the specific user concern because it does
  not explain why safety checks can take time.
- Real progress or phase labels: better long-term, but it requires a new progress
  contract from main to renderer. The current renderer only has a boolean loading
  state and the final scan result.
- Loading visibility delay: matches the style guide for actions that are often
  fast locally and slow remotely, but adds separate timing behavior beyond the
  requested trust fix. This design keeps that as follow-up scope.

## System Context

```text
[WorkspaceCleanupDialog.tsx]
        |
        v
[workspace-cleanup store slice] --enriches final candidates with tabs,
        |                         terminals, live agents, dirty buffers,
        |                         and recent visible context
        v
[window.api.workspaceCleanup.scan]
        |
        v
[main workspace-cleanup IPC handler]
        |
        +--> [local git reads]
        +--> [SSH git provider reads]
        |
        v
[WorkspaceCleanupScanResult { scannedAt, candidates, errors }]
```

The loading note is shown while the one-shot scan and renderer enrichment are
pending. It must describe the broad work in progress, not a completed finding or
a phase boundary. The wording should preserve the execution order: main-process
worktree/git inspection happens first, then renderer-side local context is
combined with the final candidates before suggestions render.

## Data Flow

- Happy path: the dialog opens, `scanWorkspaceCleanup()` sets
  `workspaceCleanupLoading`, main lists worktrees and reads git evidence, the
  renderer enriches the final candidates with local UI/runtime context, then the
  loading note disappears and grouped results render.
- Empty result: the same scan resolves with no candidates, then the existing empty
  state renders.
- Missing focused worktree: focused preflight scans can resolve without a
  candidate, and the existing remove flow reports that the workspace no longer
  exists.
- Upstream error: scan errors resolve through the existing error/notice surfaces;
  SSH repos that cannot be inspected in a broad scan may be omitted until the user
  reconnects and refreshes.

## Edge Cases

- Initial scan with no cached result should show the static note until the final
  result resolves.
- Refresh while existing scan results are visible should preserve the existing
  result-area behavior; this design only changes the initial loading banner.
- Slow SSH scans should not imply that a disconnected remote was skipped until the
  final scan result has been processed.
- Local active workspaces, open tabs, terminals, live agents, and dirty buffers
  are still enforced by the existing store enrichment and policy logic; only the
  in-flight copy changes.

## SSH and Cross-Platform Considerations

This is renderer copy and local React state only. It does not change path handling,
keyboard shortcuts, process probing, IPC contracts, SSH provider behavior, or git
provider behavior. The wording includes remote availability signals because
remote availability can affect scan duration and eligibility, but it should not
claim that unavailable remotes have been skipped before results are processed.

## Validation Plan

- Run `pnpm exec oxlint src/renderer/src/components/workspace-cleanup/WorkspaceCleanupDialog.tsx`.
- Run `pnpm run typecheck:web`.
- Inspect the diff to confirm the timer loop is removed and no fake progress state
  remains.
- Product-surface validation should verify the loading banner shows one stable
  message and does not cycle through "Protecting active work."

## Rollout

No migration or feature flag is needed. This only changes transient loading copy in
the inactive workspace cleanup dialog.
