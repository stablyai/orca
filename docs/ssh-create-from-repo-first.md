# SSH Create From: Repo-First Connection Gate

## Problem (code-verified)

- `worktrees:create` already routes SSH repos to remote creation (`createRemoteWorktree`) and fails when no SSH git provider is available (`No git provider for connection ...`).
- The New Workspace composer does not gate on SSH connectivity before source lookup:
  - `useComposerState` always prefetches work items for the selected repo.
  - `SmartWorkspaceNameField` immediately runs GitHub lookups (`fetchWorkItems`, `workItem`, `workItemByOwnerRepo`) and branch lookup (`repos:searchBaseRefs`) once repo + mode/query are present.
- `RepoCombobox` only shows an `SSH` badge; it does not expose connection state or connect action.
- Existing reconnect UX (`SshDisconnectedDialog`) is sidebar/worktree-context UX, not integrated into the composer repository step.

Result: selecting a disconnected SSH repo surfaces empty/error source results and only fails definitively at create time.

## Goal

At the Repository step, enforce: disconnected SSH repo cannot use Create From or Create Workspace until connected.

Rules:
1. A repo is a single repo entry. Do not present local/remote pairing.
2. If `selectedRepo.connectionId` exists and target status is not `connected`, show connection state + connect action inline under Repository.
3. Block source lookup and workspace creation while blocked.
4. After connection, existing Create From behavior stays unchanged.
5. Repository selection stays passive: selecting an SSH repo never auto-connects; user must explicitly choose Connect/Reconnect.

## Non-goals

- No new modal/tab flow for SSH create.
- No local fallback pairing UI.
- No SSH sparse checkout.
- No GitLab-over-SSH behavior changes in this iteration.
- Validation does not require completing password/password+passphrase auth; state transition checks are sufficient.

## Design

### 1) Derive selected-repo SSH gate state in `useComposerState`

Add derived state from `selectedRepo.connectionId` + `sshConnectionStates`:

- `selectedRepoConnectionId: string | null`
- `selectedRepoSshStatus: SshConnectionStatus | null`
- `selectedRepoRequiresConnection: boolean`
- `selectedRepoConnectInProgress: boolean`

Status policy:
- Ready: `connected`
- In progress: `connecting | deploying-relay | reconnecting`
- Connectable blocked: `disconnected | auth-failed | reconnection-failed | error`
- Missing state for SSH repo: treat as blocked/connectable (safe default)

Add `onConnectSelectedRepo` in hook, calling `window.api.ssh.connect({ targetId })`.
Do not manage credential prompts locally; existing global queue/dialog remains the source of truth.

`onConnectSelectedRepo` behavior requirements:
- If selected repo is null, local (no `connectionId`), or changed mid-click, no-op safely.
- While status is in-progress, no-op (button disabled in UI + handler guard).
- On failure, keep gate visible and surface a toast (`err.message` fallback string).

### 2) Gate both create paths (UI + submit functions)

- Extend create gate input with `selectedRepoRequiresConnection`.
- Apply to both full and quick create disabled predicates.
- Add early-return guards in `submit` and `submitQuick` using the same condition.

Why: button disabled state alone is insufficient (Enter handlers can still invoke submit callbacks).

### 3) Add repository-step inline SSH gate in `NewWorkspaceComposerCard`

Pass props from hook:
- `selectedRepoRequiresConnection`
- `selectedRepoConnectInProgress`
- `selectedRepoSshStatus`
- `selectedRepoConnectionId`
- `onConnectSelectedRepo`

Render a compact inline panel under `RepoCombobox` when SSH repo is not connected:
- repository label
- status text
- connect/reconnect button (disabled while in-progress)

Keep copy neutral and actionable; no modal handoff required.

### 4) Disable Start-from field when SSH gate is active

`SmartWorkspaceNameField` additions:
- `disabled?: boolean`
- `disabledPlaceholder?: string`

When disabled:
- input disabled
- popover closed and cannot reopen
- all source-fetch effects short-circuit
- clear loading flags and transient result sets
- keep selected-source clear action available

Placeholder: `Connect this repo first`.

### 5) Fix prefetch invalidation and avoid stale-empty warmup

Current `useComposerState` prefetch runs unconditionally on selected repo; for disconnected SSH it can warm cache with empty/error-adjacent data.

Change prefetch guard:
- run only when repo is local OR selected SSH status is `connected`.

Requery triggers:
- selected repo id/path change
- selected repo SSH status transitions to `connected`
- `sshConnectedGeneration` bump (secondary safety signal)

Important: `sshConnectedGeneration` is global, not per-target. Use it only with repo+status guards to avoid unrelated refetch churn.

### 6) Concurrency + consistency requirements

- Multi-window: another window may initiate connect; composer must react only to store state, no local optimistic connected state.
- External mutations: repo removed/changed while panel visible must collapse gate safely (null selected repo => no action).
- Connect dedupe: main `ssh:connect` already serializes in-flight calls per target; composer should still disable button on in-progress statuses.
- Status races: `ssh.connect()` resolve timing can precede renderer state updates; UI must remain gated until store status is `connected`.

## Edge cases

- SSH target missing from `sshConnectionStates`: blocked, show connect action.
- Repo switch while previous repo is connecting: panel rebinds to newly selected repo only.
- Create invoked via keyboard while blocked: submit early-return prevents bypass.
- Connect failure/auth failure: keep gate visible; surface toast from connect handler.
- Stale selected source from previous repo: existing repo-switch reset logic remains authoritative.
- Repo removed while gate visible: panel and callback must collapse/no-op without throw.

## Feasibility notes

- No one-call shortcut exists to both connect and guarantee credentials complete without user interaction; this is expected.
- Gating on `connected` aligns with existing backend behavior: remote create requires active SSH git provider and otherwise fails.

## Rollout

1. `useComposerState`: derive SSH gate state, expose connect callback, integrate create gating, and guard prefetch.
2. `SmartWorkspaceNameField`: add disabled mode and fetch short-circuit behavior.
3. `NewWorkspaceComposerCard`: render inline repository-step SSH gate.
4. Tests:
   - create disabled + submit early-return while disconnected SSH
   - source-fetch suppression while blocked
   - refetch after status becomes `connected`
   - repo-switch and multi-window state update behavior
   - connect callback no-op for local/null/stale selected repo
   - connect callback failure toast path
5. Manual validation with password-protected SSH repo:
   - confirm gate and disabled states before auth completion
   - confirm connect enters in-progress/credential path
   - confirm Create From/Create stay blocked until status is `connected`
   - confirm canceling credential prompt leaves status blocked and UI still gated
