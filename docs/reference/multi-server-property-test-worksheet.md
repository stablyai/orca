# Multi-Server Repo Refresh Test Worksheet

## Scenario

Orca can show the same project from more than one execution host: local, SSH, and
runtime server. A user may add `orca` locally, connect to a server that has its
own `orca` checkout, switch focus between the hosts, then reload the app with
`Cmd+Shift+R`.

The test harness needs to catch state crossing those host boundaries. Refreshing
server B must not remove, overwrite, or re-own the local checkout for project A.

## Invariants

- Repo identity is scoped by execution host plus repo id.
- A shared provider project can merge multiple host checkouts into one
  `Project`, but each checkout keeps its own `ProjectHostSetup`.
- Runtime-fetched repos are stamped with `executionHostId: runtime:<env>`.
- Local repos are stamped with `executionHostId: local`.
- Refreshing one host replaces only that host's fetched repos.
- Generated add, remove, rename, reorder, and refresh sequences preserve every
  host partition.
- Project source repo ids remain the union of the surviving host checkouts.

## Current Coverage

- `src/renderer/src/store/slices/repo-host-refresh-merge.test.ts`
  checks host-scoped repo merge behavior directly.
- `src/renderer/src/store/slices/project-host-setup-compatibility-merge.test.ts`
  checks shared project compatibility after one host refreshes.
- `src/renderer/src/store/slices/multi-host-repo-refresh.property.test.ts`
  runs seeded operation sequences across local and two runtime hosts.
- `src/renderer/src/store/slices/repos-multi-host-refresh.test.ts`
  drives the renderer store through local IPC and runtime RPC refreshes.

## Next Seams

- Worktree refresh: `src/renderer/src/store/slices/worktrees.ts`.
- Reload event routing: `src/renderer/src/hooks/useIpcEvents.ts`.
- Session partitioning: `src/renderer/src/lib/workspace-session-host-split.ts`
  and `src/renderer/src/lib/workspace-session-host-persistence.ts`.
- Main persistence: `src/main/persistence.ts` host-keyed workspace sessions.
