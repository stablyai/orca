# TASK-BE-STORAGE-008: wscompat `connectivity.getSummary` / `agentSession.listActive` + xác nhận `devServer.*`/`ssh.*`

**Solution:** BE-SOL-STORAGE-002 | **CRs:** CR-STORAGE-006, CR-STORAGE-007
**Service:** `api-gateway`
**Depends on:** TASK-BE-STORAGE-005 (audit), TASK-BE-STORAGE-006, TASK-BE-STORAGE-007
**Status:** ✅ DONE (2026-09-08) — both halves complete. `agentSession.listActive`
unblocked once `TASK-BE-STORAGE-007` landed `user_id` on `dispatch_contexts`
directly (not via `coordinator_runs`, see that task's updated notes).
Registered in the same `channels_orchestration.go` file
`orchestration.dispatchShow` already lives in (not a new file — reusing the
existing `registerOrchestrationChannels(r, client)` wiring). 3 tests:
`TestAgentSessionListActiveChannel_UserIDComesFromIdentityNotArgs`,
`_ReturnsCamelCaseFields`, `_EmptyReturnsEmptyArrayNotNull` — all pass, plus
full `go test ./internal/adapter/wscompat/...` (24.5s, all packages ok).
Response uses a dedicated `agentSessionView` camelCase struct (same
BE-SOL-001-documented reason as `connectivity.getSummary`).

## Kết quả thực hiện (phần `connectivity.getSummary`)

- `connectivity.getSummary` implemented in
  `backend-go/services/api-gateway/internal/adapter/wscompat/channels_infra_fleet.go`
  (new file) — calls `infraFleetClient.GetFleetConnectivitySummary`,
  scoping via `Identity`/gRPC metadata only (request body ignored), returns
  `{"connections": [...]}` where each entry is an explicit
  `connectionHealthView` (`connectionId`, `devServerId`, `status`,
  `lastActivityAt`, `degradedSince` — camelCase, matching
  `infrafleetv1.ConnectionHealthEntry`'s real field set). Registered from
  `RegisterRealChannels` in `channels.go` (one new line,
  `registerInfraFleetChannels(r, infraFleetClient)`); no `main.go` change
  needed — `infraFleetClient` was already dialed and passed into
  `RegisterRealChannels` for other channel groups.
- Tests in `channels_infra_fleet_test.go`:
  `TestConnectivityGetSummaryChannel_UserIDComesFromIdentityNotArgs`,
  `TestConnectivityGetSummaryChannel_ReturnsCamelCaseFields`,
  `TestConnectivityGetSummaryChannel_EmptyReturnsEmptyArrayNotNull` — all
  pass (verified in an isolated copy of the module tree; the shared
  checkout has unrelated concurrent WIP — `channels_ephemeral_vm.go`,
  `channels_star_nag*.go`, `channels_onboarding_test.go` — mid-edit by
  other agents that currently fails to build for reasons unconnected to
  this task; this task's own files build and test clean in isolation and
  are untouched by that breakage).
- `agentSession.listActive` **deliberately NOT attempted** — TASK-BE-STORAGE-007
  is blocked (no field maps `DispatchContext` to a user; see that task's
  writeup and BE-SOL-STORAGE-002's "Investigation result" section). Nothing
  under `orchestration-service` was touched.

---

## Mục tiêu

Expose 2 RPC mới qua wscompat + xác nhận namespace `devServer.*`/`ssh.*`
đã tồn tại đúng như frontend cần (không thêm namespace mới cho phần này
trừ khi audit TASK-BE-STORAGE-005 phát hiện thiếu).

## Files cần sửa

1. `backend-go/services/api-gateway/internal/adapter/wscompat/channels_infra_fleet.go` (MODIFY nếu tồn tại, hoặc MỚI)
2. `backend-go/services/api-gateway/internal/adapter/wscompat/channels_orchestration.go` (MODIFY nếu tồn tại, hoặc MỚI) — cho `agentSession.listActive`
3. File test tương ứng cho 2 file trên

## Nội dung (xem BE-SOL-STORAGE-002 §4)

```go
r.Register("connectivity.getSummary", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
	resp, err := infraFleetClient.GetFleetConnectivitySummary(rpcCtx, &infrafleetv1.GetFleetConnectivitySummaryRequest{})
	if err != nil { return nil, err }
	return map[string]any{"connections": toConnectionHealthViews(resp.GetConnections())}, nil
})

r.Register("agentSession.listActive", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
	resp, err := orchestrationClient.ListActiveDispatchContextsForUser(rpcCtx, &orchestrationv1.ListActiveDispatchContextsForUserRequest{})
	if err != nil { return nil, err }
	return map[string]any{"dispatchContexts": toDispatchContextViews(resp.GetDispatchContexts())}, nil
})
```

**Camel-case view struct** — theo đúng finding đã ghi nhận ở `BE-SOL-001`
mục 3 (protoc-gen-go's `encoding/json` tag là snake_case, wscompat serialize
bằng `encoding/json` thuần) — viết `toConnectionHealthViews`/
`toDispatchContextViews` trả về struct có tag camelCase tường minh, **không**
trả thẳng `*infrafleetv1.ConnectionHealthEntry`/`*orchestrationv1.DispatchContextSummary`
qua `map[string]any{"connections": resp.GetConnections()}` — đây là lỗi đã
biết ở các channel cũ, KHÔNG lặp lại ở channel mới này.

## Test cases cần cover

- `TestConnectivityGetSummaryChannel_UserIDComesFromIdentityNotArgs` (dù
  request rỗng, xác nhận scoping vẫn qua `Identity`/metadata, không có
  cách nào truyền `tenantId` giả qua `args`)
- `TestConnectivityGetSummaryChannel_ReturnsCamelCaseFields` — assert JSON
  response có key `connectionId` không phải `connection_id`
- `TestAgentSessionListActiveChannel_EmptyReturnsEmptyArrayNotNull`

## Verify

```bash
cd backend-go/services/api-gateway && go build ./...
go test ./internal/adapter/wscompat/... -run "TestConnectivity|TestAgentSession" -v
go test ./...
```

## gitnexus

`impact({target: "registerInfraFleetChannels", direction: "upstream"})` /
tương đương cho orchestration channels — trước khi thêm registration mới
vào hàm khởi tạo đã có (nếu file `channels_infra_fleet.go` đã tồn tại với
channel khác, xác nhận không phá quy ước đặt tên/thứ tự hiện có).

## Blocking

FE-TASK-STORAGE-012/014 (frontend hydrate + connectivity poll) phụ thuộc 2
channel này.
