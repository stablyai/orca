# TASK-BE-STORAGE-007: RPC `ListActiveDispatchContextsForUser` (orchestration-service)

> **Status: ✅ DONE (2026-09-08)** — unblocked via a different linkage than
> originally scoped. Investigation (below, kept as-is) correctly found
> `coordinator_runs.user_id` unreachable (no RPC creates a coordinator_runs
> row — `StartCoordinatorRun` is a separate, much larger effort, tracked at
> `specs/backend-go/bugs/logic-v1/tasks/TASK-TG-04-04-real-complex-executor.md`
> and its own dependency chain through task-service's grant/permission
> subsystem — explicitly NOT built here to avoid duplicating/conflicting
> with that already-planned work). Instead: `user_id` added directly to
> `dispatch_contexts` (migration `0002_dispatch_context_user_id`), populated
> from the authenticated identity at `CreateDispatchContext` time (the one
> RPC in this service with a real, working production caller —
> `api-gateway`'s `handleCreateDispatchContext` REST route, which already
> resolves identity). `ListActiveDispatchContextsForUser` filters
> `dispatch_contexts` directly by `(tenant_id, user_id)`, excluding terminal
> statuses (completed/failed/circuit_broken) — no `coordinator_runs`
> involved at all.
>
> Along the way, found and fixed a real, pre-existing bug in
> `CreateDispatchContext`'s SQL: `NULLIF($6,'')` against the `uuid`-typed
> `orchestration_task_id` column failed type inference at bind time
> (`column ... is of type uuid but expression is of type text`) — this was
> silently breaking every ad-hoc (task-less) dispatch context creation,
> including the exact path `TestRepository_CreateGate_FailsWhenDispatchContextHasNoTask`
> was supposed to exercise (that test was failing before this fix, for a
> reason unrelated to what it names). Fixed by resolving `*string` (nil for
> "no task") in Go instead of relying on SQL-side `NULLIF` type coercion.
>
> **Real verification, not just compiled:**
> ```
> cd backend-go/services/orchestration-service
> GOWORK=off go build ./... && GOWORK=off go vet ./...          # clean
> GOWORK=off go test ./...                                       # ok (unit)
> GOWORK=off go test -tags=integration ./internal/adapter/postgres/... \
>   -run TestRepository_ListActiveDispatchContextsForUser -v      # PASS (3/3 reruns, real Postgres via testcontainers)
> GOWORK=off go test -tags=integration ./internal/adapter/postgres/... \
>   -run TestRepository_CreateGate_FailsWhenDispatchContextHasNoTask -v  # now PASS (was failing before this fix)
> ```
> New test: `TestRepository_ListActiveDispatchContextsForUser_ReturnsOnlyCallerNonTerminal`
> — covers tenant isolation (same user_id string, different tenant → excluded),
> per-user filtering, and terminal-status exclusion, all against a real
> Postgres. 4 pre-existing, unrelated integration test failures remain
> (`parent_id`/`uuid` type mismatch on `orchestration_tasks` — a different
> root cause, not touched here, likely never-run-before tests per the same
> class of issue `docs/execution-plan.md` §11 already documented for
> workflow-service).
>
> `buf generate` regenerated `orchestration`'s proto cleanly; 3 other
> services' generated code also changed (`gitgateway`/`scmintegration`/
> `tenant` — their `.proto` sources were already modified by other
> concurrent sessions; regenerating is correct, not reverted, per the same
> reasoning `TASK-BE-STORAGE-012` documented). All 7 potentially-affected
> services (`orchestration-service`, `tenant-service`, `infra-fleet-service`,
> `git-gateway-service`, `scm-integration-service`, `api-gateway`,
> `task-service`) build clean.
>
> See `specs/backlog/BACKLOG-006-dispatch-context-user-linkage-decision.md`
> for the full "why not coordinator_runs.user_id" writeup (kept, marked
> resolved) and `TASK-BE-STORAGE-008` for the wscompat wiring this unblocks.

---

**(Lịch sử điều tra gốc — giữ nguyên để tham khảo):**
🔲 BLOCKED — needs product/architecture decision — 2026-09-07.
> **Investigation only, no code changed.** Full writeup appended to
> [BE-SOL-STORAGE-002 §"Investigation result: DispatchContext-to-user mapping"](../solutions/BE-SOL-STORAGE-002-dev-server-agent-hydration-and-health.md#investigation-result-dispatchcontext-to-user-mapping-task-be-storage-007).
>
> Read the real domain (`backend-go/services/orchestration-service/internal/domain/orchestration.go`)
> and the real migration (`backend-go/services/orchestration-service/migrations/0001_init.up.sql`,
> matches TDD §5 exactly, no drift). Confirmed: `DispatchContext.Handle`
> (the proto's `assignee_handle`) is a `KeyedAsyncQueue` serialization key
> for the terminal/agent-worker — not a user identifier (proto source
> comment: `// KeyedAsyncQueue serialization key`; TDD §6 corroborates).
> Neither `DispatchContext`, `OrchestrationTask`, nor `CoordinatorRun`
> carries `project_id`/`user_id`/`created_by`/`requested_by` — only
> `tenant_id` and an opaque logical FK (`origin_task_id`, a different id
> space in `task-service`, `orchestration_tasks` root row only) not locally
> resolvable to a project or user. `grep` for those field names across the
> whole service (excluding tests) returned zero hits.
>
> The only theoretical path to "user" requires: walking `ParentID` up to
> the DAG root `OrchestrationTask` to find its `OriginTaskID`, a **new**
> outbound gRPC client from `orchestration-service` to `task-service` (and
> likely `project-service`) to resolve that task's `project_id` and check
> the calling user's membership — none of which exists today and none of
> which fits inside the file scope given for this task (no client wiring
> file was in scope). It would also change the RPC's actual semantics from
> "belongs to this user" to "any dispatch context under a project this user
> is a member of" — a materially different, broader guarantee than the RPC
> name promises.
>
> Per this task's own explicit stop condition, no filter was guessed and no
> proto/usecase/grpc/repository/main.go file was touched. **TASK-BE-STORAGE-008's
> `agentSession.listActive` wscompat wiring is correspondingly NOT
> started** — it depends on this RPC.

**Solution:** BE-SOL-STORAGE-002 | **CR:** CR-STORAGE-006, CR-STORAGE-007
**Service:** `orchestration-service`
**Depends on:** Không, nhưng xem "Rủi ro" trước khi bắt đầu
**Status:** 🔲 BLOCKED — needs product/architecture decision

---

## Mục tiêu

RPC mới — list mọi `DispatchContext` đang active của 1 user, gồm luôn
`status`/`failure_count`/`last_heartbeat_at` để dùng chung cho cả hydrate
(CR-STORAGE-006) lẫn health (CR-STORAGE-007), tránh cần 2 RPC riêng.

## ⚠️ Điều kiện tiên quyết — xác nhận TRƯỚC khi viết code

`DispatchContext.assignee_handle` mô tả "which agent worker", **có thể
không map 1:1 về `user_id`**. Đọc `orchestration-service.md` §4 (domain
model) + code thật của `DispatchContext` trước khi viết filter — nếu
`assignee_handle` không phải user_id, cần xác định đúng field nào liên kết
1 dispatch context với "user đang gọi RPC này" (có thể qua `tenant_id` +
`project_id` mà user có quyền, không phải lọc trực tiếp theo user). **Nếu
không tìm ra đường liên kết rõ ràng, dừng lại và báo cáo thay vì đoán** —
đây đúng là điều BE-SOL-STORAGE-002 §6 cảnh báo.

## Files cần sửa

1. `backend-go/proto/orca/orchestration/v1/orchestration.proto` (MODIFY)
2. `backend-go/services/orchestration-service/internal/usecase/list_active_dispatch_contexts_for_user.go` (MỚI)
3. `backend-go/services/orchestration-service/internal/adapter/grpc/server.go` (MODIFY)
4. `backend-go/services/orchestration-service/internal/adapter/postgres/dispatch_context_repository.go` (MODIFY — query mới)

## Nội dung proto

```protobuf
message ListActiveDispatchContextsForUserRequest {}   // user từ metadata
message DispatchContextSummary {
  string dispatch_context_id = 1;
  string status = 2;
  int32 failure_count = 3;
  google.protobuf.Timestamp last_heartbeat_at = 4;
  // + field hiện có khác của DispatchContext cần cho frontend map sang RemoteAgentSession
}
message ListActiveDispatchContextsForUserResponse {
  repeated DispatchContextSummary dispatch_contexts = 1;
}
rpc ListActiveDispatchContextsForUser(ListActiveDispatchContextsForUserRequest) returns (ListActiveDispatchContextsForUserResponse);
```

## Test cases cần cover

- `TestListActiveDispatchContextsForUser_ScopedCorrectly` — đúng theo cách
  liên kết user xác định được ở bước điều kiện tiên quyết (tên test cụ thể
  phụ thuộc kết quả điều tra đó).
- `TestListActiveDispatchContextsForUser_ExcludesTerminalStatuses` — chỉ
  trả dispatch context đang active, không trả `completed`/`failed`.
- `TestListActiveDispatchContextsForUser_EmptyReturnsEmptyArrayNotNull`

## Verify

```bash
cd backend-go && buf generate
cd backend-go/services/orchestration-service && go build ./... && go test ./...
```

## gitnexus

`impact({target: "DispatchContext", direction: "upstream"})` trước khi
thêm query mới — xác nhận không có usecase nào khác giả định 1 query shape
cụ thể trên bảng này mà thay đổi ở đây có thể phá.

## Blocking

TASK-BE-STORAGE-008 (wscompat `agentSession.listActive`) phụ thuộc RPC
này. Nếu điều kiện tiên quyết không giải quyết được rõ ràng, **không**
tiến hành TASK-BE-STORAGE-008's phần `agentSession.listActive` — báo cáo
lại thay vì đoán mapping.
