# Resource Manager Unbound Session Safety

**Date:** 2026-07-13
**Status:** Approved for implementation planning
**Related:** [#8459](https://github.com/stablyai/orca/issues/8459), upstream lifecycle trigger [#8457](https://github.com/stablyai/orca/issues/8457)

## Problem

Resource Manager currently calls every daemon session absent from the current renderer binding index an **orphan**. That index is built from renderer-owned tab, PTY, and persisted layout state. It can be incomplete during renderer recovery, deferred reattach, headless/mobile ownership, or other synchronization gaps.

The destructive path treats this renderer-only absence as proof that a session is safe to reclaim:

- an unbound row skips confirmation and immediately calls `pty.kill`;
- **Kill orphan terminals** sends every currently unbound ID to `pty.kill` without review;
- `pty.kill` always requests provider shutdown with `immediate: true`.

The 2026-07-13 incident showed 25 apparent orphans in the UI and produced 28 immediate daemon kills in roughly 50 ms, including live AI sessions. The lifecycle mismatch in #8457 exposed the problem, but the unsafe classification and cleanup policy remains independently reachable whenever renderer state is stale or incomplete.

## Goals

- Use **unbound** for the renderer fact and reserve **inactive** for a main-process liveness decision.
- Never bulk-kill a session solely because it is absent from the renderer binding index.
- Inspect process state through the owning local, daemon, or SSH provider before offering bulk cleanup.
- Re-run the same liveness check in the main process immediately before shutdown.
- Protect active, disconnected, unsupported, and otherwise ambiguous sessions from the ordinary bulk-cleanup action.
- Require an explicit confirmation for every destructive session action, including an individual unbound row.
- Keep expensive provider inventory and foreground inspection user-triggered; do not add background polling.

## Non-goals

- Fixing the `orca serve` / GUI single-instance lifecycle in #8457; that is the next independent PR.
- Automatically adopting every headless/mobile session into the desktop tab graph.
- Replacing Settings → Manage Sessions or changing its separately confirmed **Kill all sessions** behavior.
- Guessing agent identity from titles, command text, workspace names, or renderer activity badges.
- Claiming that an idle shell is ownerless. It is only an eligible cleanup candidate after the user reviews and confirms it.
- Adding a bulk force-kill path for active or ambiguous sessions.

## Terminology and invariants

| Term | Meaning |
| --- | --- |
| Bound | The current ready renderer has a live or persisted/restorable tab/layout binding for the PTY ID. |
| Unbound | The current ready renderer has no such binding. This is a renderer fact, not kill authorization. |
| Inactive | Main confirms the provider still owns the session, it has no child process, and its freshly confirmed foreground process is a known shell. |
| Active | Main has positive evidence of a child process or a freshly confirmed non-shell foreground process. |
| Unknown | Provider ownership, inventory, child state, or fresh foreground identity cannot be confirmed. |
| Gone | A fresh provider inventory no longer contains the session. |

The safety invariant is:

> Ordinary bulk cleanup may shut down only IDs that are still unbound in the current renderer state and are reclassified as inactive by main immediately before shutdown. Active and unknown IDs are protected.

An inactive result is fail-closed: it requires all positive evidence. `false` child state plus a `null` foreground process is **unknown**, not inactive.

## Architecture

### 1. Keep renderer binding classification narrow and honest

`resource-session-bindings.ts` remains the renderer ownership index. Its output continues to drive navigation and the unbound count, but the UI stops describing that count as orphaned or reclaimable.

Resource Manager changes the bulk affordance from **Kill N orphan terminals** to **Review N unbound terminals**. A gray/unbound row may still expose its individual kill button, but clicking it opens the existing force-kill confirmation just like a bound row; it never bypasses confirmation.

No provider inspection runs while the Resource Manager popover is closed or merely open. It begins only when the user chooses the review action.

### 2. Add a main-owned cleanup-safety classifier

Add shared wire types for a bounded batch inspection result:

```ts
export type PtyCleanupSafety = 'inactive' | 'active' | 'unknown' | 'gone'

export type PtyCleanupInspection = {
  id: string
  safety: PtyCleanupSafety
}

export type PtyInactiveCleanupResult = {
  id: string
  outcome: 'killed' | 'protected-active' | 'protected-unknown' | 'gone' | 'failed'
}
```

The main classifier receives deduplicated PTY IDs, resolves each ID to its actual local/daemon/SSH provider, and groups IDs by provider so `listProcesses()` runs once per provider per operation.

For every ID in a successful provider inventory:

1. Missing from the fresh inventory → `gone`.
2. Run `hasChildProcesses(id)` and `confirmForegroundProcess(id)`.
3. Positive child evidence or a confirmed non-shell foreground → `active`.
4. No child process **and** a non-null foreground accepted by shared `isShellProcess()` → `inactive`.
5. Missing provider, disconnected SSH, unsupported fresh foreground confirmation, null foreground, inspection rejection, or inconsistent evidence → `unknown`.

Provider paths remain runtime-routed. The classifier must not inspect SSH processes using local `ps`, and it must not fall back from a missing SSH provider to the local provider.

### 3. Separate review from guarded execution

Expose two batched preload APIs:

```ts
inspectInactiveCleanup(ids: string[]): Promise<PtyCleanupInspection[]>
killInactiveSessions(ids: string[]): Promise<PtyInactiveCleanupResult[]>
```

`inspectInactiveCleanup` powers the review dialog. `killInactiveSessions` does **not** trust the earlier review result: it re-runs provider inventory and process classification inside the main handler, then calls the existing exact PTY shutdown path only for IDs still classified `inactive`.

The normal `pty.kill` API remains the explicit force operation used by individual confirmation. The guarded bulk API is deliberately separate so a future caller cannot accidentally turn a preflight result into unrestricted kill authority.

### 4. Reconcile renderer state at both user boundaries

The renderer review coordinator performs this sequence:

1. Fetch a fresh `pty.listSessions()` snapshot. This also rebuilds SSH ownership routing.
2. Read `useAppStore.getState()` after the fetch and rebuild the current binding index.
3. Remove every currently bound ID from the review set.
4. Ask main to inspect the remaining IDs.
5. Show counts for inactive candidates, active protected sessions, unknown protected sessions, and already-gone sessions.

When the user confirms:

1. Fetch daemon sessions again.
2. Re-read current renderer state and intersect the reviewed inactive IDs with IDs that are both still present and still unbound.
3. Send only that intersection to `killInactiveSessions`.
4. Main reclassifies immediately and shuts down only IDs still inactive.
5. Refresh Resource Manager and show the bounded result in the dialog.

This prevents the initial popover snapshot, the review snapshot, or a stale renderer closure from directly authorizing a kill. A new session created after review is never chased.

## User experience

Use the existing shadcn `Dialog` and `Button` primitives and documented tokens. The bulk review dialog is a sibling of `PopoverContent`, matching the existing individual kill dialog lifetime and focus behavior.

States:

| State | UI behavior |
| --- | --- |
| Reviewing | Dialog opens with **Checking current process activity…**; controls are disabled. |
| Candidates found | Show **N inactive terminals can be closed** and **M active or unverified terminals will be protected**. |
| No inactive candidates | No destructive action; explain that all unbound terminals are active, unverified, or already exited. |
| Confirming | Destructive button reads **Kill N inactive terminals**; Cancel remains quiet/outline. |
| Running | Disable dismissal and show **Killing…** with the canonical `LoaderCircle`. |
| Completed | Report killed, protected, gone, and failed counts without claiming processes were killed when the provider returned uncertainty. |
| Review failure | Keep the dialog open with a persistent retryable error; kill remains disabled. |

The dialog never exposes workspace paths, command lines, or foreground process names. Counts are sufficient to make the safety boundary visible without leaking terminal contents.

Individual row copy remains consequence-first: **Force-quits this terminal. Any unsaved work in the pane is lost. This can't be undone.** This is the explicit force path for a user who intentionally chooses one active or ambiguous session.

## Concurrency and failure behavior

| Case | Required behavior |
| --- | --- |
| Renderer hydration not ready | Unbound count and review action remain unavailable. |
| Session becomes bound during review | Current-state intersection removes it before the guarded kill request. |
| Session starts a process after review | Main reclassification protects it as active or unknown. |
| Session exits after review | Main returns `gone`; no shutdown is attempted. |
| New session appears after review | It is outside the immutable reviewed ID set and survives. |
| SSH provider disconnects | Candidate becomes `unknown` and is protected. |
| Provider inventory or inspection rejects | Candidate becomes `unknown`; other provider groups continue. |
| One eligible shutdown rejects | Return `failed` for that ID; continue settling other eligible IDs. |
| Dialog/component unmounts after confirmation | Main operation settles; React state updates remain mount-gated. |
| Two reviews overlap | Each operates only on its reviewed IDs; main revalidation keeps both idempotent and fail-closed. |

## File boundaries

| Path | Responsibility |
| --- | --- |
| `src/shared/pty-inactive-cleanup.ts` | Wire types, input normalization, and result unions. |
| `src/main/ipc/pty-inactive-cleanup.ts` | Provider-grouped inspection and fail-closed classification. |
| `src/main/ipc/pty.ts` | Register the two IPC handlers and reuse the existing exact shutdown lifecycle. |
| `src/preload/index.ts`, `src/preload/api-types.ts` | Typed renderer bridge for review and guarded cleanup. |
| `src/renderer/src/components/status-bar/use-resource-session-cleanup-review.ts` | Fresh inventory/binding reconciliation and review/execute state machine. |
| `src/renderer/src/components/status-bar/ResourceSessionCleanupDialog.tsx` | Review, confirmation, progress, error, and result UI. |
| `src/renderer/src/components/status-bar/ResourceUsageStatusSegment.tsx` | Honest unbound copy, individual confirmation, and coordinator wiring only. |

The policy and dialog stay outside the already-large status-bar component. No max-lines disable or threshold increase is added.

## Testing

### Main and shared policy

- An inventoried idle `zsh`, `bash`, `fish`, `pwsh`, PowerShell, CMD, and Git Bash session is inactive only when child inspection is also false.
- Confirmed `codex`, `claude`, or any other non-shell foreground is active.
- Child-process evidence protects a session even if the foreground reports a shell.
- Null foreground, missing confirmation support, inspection rejection, failed inventory, and disconnected SSH are unknown/protected.
- Missing inventory ID is gone.
- Provider inventory runs once per provider group.
- Guarded kill re-inspects and never calls shutdown for active, unknown, or gone IDs.
- Guarded kill settles independent shutdown failures and preserves SSH routing.

### Renderer coordinator and UI

- Review uses a fresh daemon snapshot and post-fetch store state, not captured bindings.
- Bound sessions and sessions created after review are excluded.
- A reviewed candidate that becomes bound before confirmation survives.
- Main inspection counts map to accurate dialog copy and destructive-button enablement.
- Confirm sends only reviewed, still-present, still-unbound inactive IDs.
- Final protected/gone/failed outcomes remain visible and do not overclaim success.
- Individual unbound rows open the force-kill confirmation and never call `pty.kill` on the first click.
- Popover-closed behavior still performs zero background session or inspection polling.

### Verification surface

- Focused Vitest suites for the classifier, IPC handlers, coordinator, dialog, bindings, merge, and row behavior.
- Node and web typecheck.
- Lint, localization verification, max-lines ratchet, and reliability-gate checks.
- Desktop build.
- Manual packaged Electron smoke with disposable local idle shells plus a running agent; verify bulk review protects the agent and closes only confirmed idle shells.
- SSH smoke when the existing fixture is available; otherwise record live SSH process verification as not run while retaining deterministic provider-contract coverage.

Add an experimental partial reliability-gate entry for the invariant: **renderer absence alone never authorizes PTY shutdown; guarded cleanup kills only freshly confirmed inactive shells**.

## Success criteria

- The original incident state may show unbound sessions, but it cannot label them safe or bulk-kill live agents.
- Clicking the bulk action performs review first and presents protected vs inactive counts.
- Active and unknown sessions survive the ordinary bulk cleanup even when renderer bindings are empty.
- Every actual bulk shutdown is authorized by a fresh renderer intersection plus a fresh main-process inactive classification.
- Individual destructive actions always require confirmation.
- Native, daemon, and SSH paths share the same fail-closed policy without local-only assumptions.

## Rollout

1. Land #8459 as the safety PR with deterministic tests and the guarded IPC contract.
2. Validate packaged behavior using disposable sessions; do not use existing user agents as the test target.
3. After CI is green, implement #8457 separately so GUI relaunch cannot create the stale lifecycle state that exposed this safety bug.
