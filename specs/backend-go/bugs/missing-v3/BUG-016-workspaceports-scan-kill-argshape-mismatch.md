# BUG-016: `workspacePorts.scan`/`workspacePorts.kill` decode `{connectionId, worktreeId}`, but the real frontend only ever sends `{repoId}` — every call silently no-ops

**Severity:** Medium — the "Workspace Ports" feature (view/kill dev-server ports in use by a repo/worktree) is registered, reaches a real backend usecase, and returns a well-formed success response, but is functionally dead for every real caller: `scan` always reports zero open ports and `kill` always fails with a fixed "not implemented" reason, with no visible error to the user (both look like legitimate answers, not a broken call). Not High because the feature is a secondary port-management convenience, not a core workflow, and the failure mode is silent rather than crash-shaped.
**Status:** Resolved 2026-09-07 — `registerWorkspacePortsChannels` (channels_repo_ssh_status_workspace.go) now takes a `projectv1.ProjectServiceClient` and resolves `workspacePorts.scan`/`kill`'s `{connectionId, worktreeId, repoId}` args down to a real `(connectionId, worktreeId)` pair before calling infra-fleet-service, in priority order: (1) an explicit `worktreeId` (unambiguous) resolved via the existing `resolveConnectionIDForWorktree`/`ResolveConnection(worktree_id=)` helper; (2) otherwise `repoId`, resolved server-side via a new `resolveWorktreeIDForRepo` (`GetRepo(repoId)` for `project_id`, then `ListWorktrees(project_id)` filtered to that repo — exactly one ACTIVE worktree resolves; a single non-active worktree falls back like `workspace.refreshFileTree`; zero or 2+ active worktrees degrades to the pre-existing safe empty-`connectionId` no-op rather than guessing, since multiple active worktrees per repo is a real, verified case, not just a theoretical one). Deviation from "fix direction": also threaded a real `worktreeId` field into the frontend's `killWorkspacePortForTarget` wire contract (`workspace-port-actions.ts`, `shared/workspace-ports.ts`, and its 3 call sites) since `WorkspacePort.owner.worktreeId` is already known precisely at every real kill call site — strictly better than any repoId-based guess — while `scan`'s real call sites (never pass `repoId` at all; they scan-then-filter-client-side) were left as-is to avoid scope creep into that separate, larger "environment-wide scan" architecture question (see BUG-SSH-04). New/updated tests: `channels_repo_ssh_status_workspace_test.go` (`TestRegisterWorkspacePortsChannels` resolution subtests + `TestResolveWorktreeIDForRepo`), `workspace-port-actions.test.ts`. `go build`/`go vet`/`go test` clean for api-gateway; `tsc --noEmit` and `vitest` clean for all touched frontend files.

---

## The mismatch

Handler — `backend-go/services/api-gateway/internal/adapter/wscompat/channels_repo_ssh_status_workspace.go:798-839`:

```go
func registerWorkspacePortsChannels(r *Registry, client infrafleetv1.InfraFleetServiceClient) {
	r.Register("workspacePorts.scan", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type scanArgs struct {
			ConnectionID string `json:"connectionId"`
			WorktreeID   string `json:"worktreeId"`
		}
		in, err := decodeArg[scanArgs](args, 0)
		...
		resp, err := client.ScanWorkspacePorts(rpcCtx, &infrafleetv1.ScanWorkspacePortsRequest{
			ConnectionId: in.ConnectionID,
			WorktreeId:   in.WorktreeID,
		})
		...
	})

	r.Register("workspacePorts.kill", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type killArgs struct {
			ConnectionID string `json:"connectionId"`
			WorktreeID   string `json:"worktreeId"`
			PID          int32  `json:"pid"`
			Port         int32  `json:"port"`
		}
		...
	})
}
```

Frontend caller — `frontend/src/renderer/src/lib/workspace-port-actions.ts:279-334` (`runWorkspacePortScanForTarget`/`killWorkspacePortForTarget`, the only two call sites for these RPCs):

```ts
async function runWorkspacePortScanForTarget(
  target: RuntimeClientTarget,
  repoId?: string
): Promise<WorkspacePortScanResult> {
  const params = repoId ? { repoId } : {}
  ...
  return await callRuntimeRpc<WorkspacePortScanResult>(target, 'workspacePorts.scan', params, { timeoutMs: 15_000 })
  ...
}

export async function killWorkspacePortForTarget(
  target: RuntimeClientTarget,
  args: { repoId: string; pid: number; port: number }
): Promise<WorkspacePortKillResult> {
  ...
  return await callRuntimeRpc<WorkspacePortKillResult>(target, 'workspacePorts.kill', args, { timeoutMs: 15_000 })
  ...
}
```

The frontend sends `{repoId}` / `{repoId, pid, port}` — there is no `connectionId` or `worktreeId` field anywhere in either call site's params. The handler decodes `{connectionId, worktreeId, ...}`. Go's `encoding/json` leaves missing struct fields at their zero value rather than erroring, so `decodeArg[scanArgs]`/`decodeArg[killArgs]` silently succeed with `ConnectionID == ""` and `WorktreeID == ""` on every real invocation — `repoId` is simply dropped on the floor (no field in the Go struct captures it).

## What that empty `ConnectionID` actually does downstream

`infra-fleet-service`'s usecases both branch explicitly on `ConnectionID != ""`:

- `backend-go/services/infra-fleet-service/internal/usecase/scan_workspace_ports.go:40-62` — when `ConnectionID == ""`, skips the resolve/relay branch entirely and returns `[]int32{}, nil` (comment: "the worktree is local... out of scope for this scaffold").
- `backend-go/services/infra-fleet-service/internal/usecase/kill_workspace_port.go:39-65` — same empty-`ConnectionID` branch returns `false, "local workspace-port kill is not implemented in this scaffold", nil`.

So for every real call from the shipped frontend, against any backend-go target: `workspacePorts.scan` unconditionally returns an empty port list (never the real open ports on the remote dev server, however many there actually are), and `workspacePorts.kill` unconditionally returns `{ok: false, reason: "local workspace-port kill is not implemented in this scaffold"}` — a reason string that is actively misleading here, since the request never was "local"; it just never carried the identifiers the usecase needed to know that.

## This was a known, explicitly flagged gap that was never closed

This is not a fresh discovery of unknown code — the implementation's own design docs called this out by name and left it unresolved on purpose:

- `specs/backend-go/bugs/missing-v1/tasks/TASK-169-wire-workspace-ports-scan-channel.md:21-32` ("**Arg-shape caveat**: the frontend's `killWorkspacePortForTarget`/scan call sites pass `{repoId, pid, port}` / `{repoId}`... not `{connectionId, worktreeId}` directly... Verify the exact `repoId` → `connectionId`/`worktreeId` lookup against the real frontend call site before shipping... Not resolved further here.") — marked `[x] DONE` regardless, i.e. shipped with the caveat unaddressed.
- `specs/backend-go/bugs/missing-v1/solutions/SOL-027-workspaceports-channels.md:72-85` repeats the identical caveat verbatim.
- The handler file itself still carries the same warning today (`channels_repo_ssh_status_workspace.go:783-794`, the `registerWorkspacePortsChannels` doc comment): "verify the exact repoId -> connectionId/worktreeId lookup against the real frontend call site before shipping; likely a project-service.ListWorktrees join keyed by repoId, resolved either in this handler or upstream of it. **Not resolved further here.**"

No `repoId` → `connectionId`/`worktreeId` resolution code exists anywhere in this handler, `channels_repo_ssh_status_workspace.go`, or the two usecases above — confirmed by reading the full file and both usecases; there is no `ListWorktrees` call, no repo→connection join, nothing that consumes a `repoId`. The caveat was flagged three times across two design docs and the shipped code's own comment, and never implemented.

## Why `logic-v1/BUG-SSH-04` didn't catch this

`specs/backend-go/bugs/logic-v1/BUG-SSH-04-port-forwarding-partial.md` already documents this namespace extensively, but frames the wiring as correct: its "What backend-go has" section states "`workspacePorts.scan`/`workspacePorts.kill` wscompat channels wire both RPCs, reachable from the frontend" and its "What's missing" section is entirely about the larger, separate gap (no periodic scan loop, no SSH tunnel, no local-port allocation, etc.) — it does not mention that the wiring itself never receives usable arguments from the one real frontend caller. This report's finding is narrower and precedes BUG-SSH-04's: even if the tunnel/relay infrastructure BUG-SSH-04 describes were fully built, `workspacePorts.scan`/`kill` would still get `ConnectionID=""`/`WorktreeID=""` on every call and never reach it.

## Fix direction (not implemented here)

Resolve `repoId` to `connectionId`/`worktreeId` in the handler before calling `ScanWorkspacePorts`/`KillWorkspacePort` — likely via `project-service.ListRepos`/`ListWorktrees` (a repo has at most one active worktree/connection context per the frontend's usage) or, if a repo can have several live worktrees, by also threading a `worktreeId` field into the frontend's request (the frontend already knows which worktree it's showing ports for — `workspace-port-actions.ts`'s callers have a `worktreeId` at their disposal per `workspacePortOwnerWorktreeId`, it just isn't passed into `runWorkspacePortScanForTarget`/`killWorkspacePortForTarget` today). Either fix must be made on the actual arg contract, not just the handler struct, since `repoId` is the only identifier presently on the wire.

## See also

- `specs/backend-go/bugs/logic-v1/BUG-SSH-04-port-forwarding-partial.md` — covers the much larger "no actual port-forwarding/tunnel mechanism exists" gap in this same namespace, but treats the scan/kill wiring itself as correctly reachable; this report's arg-shape mismatch is a distinct, narrower defect BUG-SSH-04 doesn't mention.
- `specs/backend-go/bugs/missing-v1/BUG-027-workspaceports-channels-not-implemented.md` and its `solutions/SOL-027-workspaceports-channels.md`/`tasks/TASK-169`/`TASK-172` — the original wiring work; the arg-shape caveat this report confirms was never closed is flagged verbatim in TASK-169/SOL-027 at the time of that work, but was never turned into its own tracked bug and was still unresolved as of this reading.
- No existing report treats this as a currently-open, standalone defect — filed here to close that gap.

## References

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_repo_ssh_status_workspace.go:775-839` (`registerWorkspacePortsChannels`, both handlers, and the doc comment already flagging the caveat)
- `backend-go/services/infra-fleet-service/internal/usecase/scan_workspace_ports.go:34-63`
- `backend-go/services/infra-fleet-service/internal/usecase/kill_workspace_port.go:33-66`
- `frontend/src/renderer/src/lib/workspace-port-actions.ts:275-341` (`runWorkspacePortScanForTarget`, `killWorkspacePortForTarget`, both real call sites)
- `specs/backend-go/bugs/missing-v1/tasks/TASK-169-wire-workspace-ports-scan-channel.md:21-32`
- `specs/backend-go/bugs/missing-v1/solutions/SOL-027-workspaceports-channels.md:72-85`
- `specs/backend-go/bugs/logic-v1/BUG-SSH-04-port-forwarding-partial.md`
