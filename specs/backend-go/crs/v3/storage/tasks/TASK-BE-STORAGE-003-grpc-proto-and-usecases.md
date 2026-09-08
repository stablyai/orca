# TASK-BE-STORAGE-003: Proto `ClientState`/`WorkspaceSession` + gRPC server methods + usecases

**Solution:** BE-SOL-STORAGE-001 | **CRs:** CR-STORAGE-001, CR-STORAGE-003, CR-STORAGE-004(a,b)
**Service:** `tenant-service`
**Depends on:** TASK-BE-STORAGE-002
**Status:** ✅ DONE (2026-09-07)

> **Kết quả thực tế:** `tenant.proto` thêm đúng 5 message pair + enum
> `ClientStateKind` + 5 `rpc` theo thiết kế BE-SOL-STORAGE-001 §5. `buf
> generate --path orca/tenant/v1/tenant.proto` chạy sạch — xác nhận bằng
> `git diff --stat proto/gen/go/` CHỈ có `tenant.pb.go`/`tenant_grpc.pb.go`
> thay đổi thêm so với baseline đã có từ trước (baseline này vốn đã có drift
> sẵn ở `gitgateway`/`infrafleet`/`scmintegration` do các task song song
> khác, không do task này gây ra — xem ghi chú môi trường bên dưới).
> `usecase/` thêm đủ 5 file mới (`GetClientState`/`SetClientState`/
> `GetWorkspaceSession`/`SetWorkspaceSession`/`PatchWorkspaceSession`) —
> **quyết định thiết kế khác nhỏ so với gợi ý ban đầu của task doc**: usecase
> KHÔNG import `tenantv1` (xác nhận không có usecase nào trong toàn bộ
> `backend-go` import `proto/gen/go` — kiểm tra bằng grep trước khi viết code)
> — `usecase.ClientStateKind` là 1 string type riêng của usecase, dịch từ
> `tenantv1.ClientStateKind` ở `adapter/grpc/server.go` (đúng vai trò "wire
> translation" của adapter layer). `Server.New(...)` nhận thêm 5 tham số
> usecase mới; `cmd/server/main.go` wire đủ. `companyID` luôn lấy qua
> `tenant.RequireTenantID(ctx)` bên trong usecase — KHÔNG có field
> `company_id` nào trong request proto, giống hệt `GetOnboardingStateRequest`.
>
> **Build/test thật đã chạy**: `go build ./...` sạch cho MỌI package trừ
> `internal/adapter/scmstarcheck` (lỗi tiền tồn tại/không liên quan — xem ghi
> chú môi trường). `go test ./internal/usecase/...` — **107/107 test PASS,
> 0 FAIL** (bao gồm `TestGetClientState_UnknownKindReturnsInvalidArgument`,
> `TestSetClientState_ThenGet_RoundTrips`,
> `TestGetWorkspaceSession_RequiresTenantContext`,
> `TestSetClientState_KindsDoNotCollide` — test riêng xác nhận 5 kind không
> lẫn dữ liệu của nhau). `gofmt -l` sạch trên mọi file đã sửa/thêm.
>
> **Ghi chú môi trường quan trọng** (không thuộc phạm vi task này, ảnh hưởng
> tới việc verify): giữa lúc thực hiện task này, một tiến trình/agent KHÁC
> chạy song song trong CÙNG working directory `/opt/repos/orca` (không có
> cô lập worktree) đã đổi branch (`main` → `feature/project-delete-ui`) và
> commit/reset nhiều lần — hệ quả: mọi edit CHƯA COMMIT của phiên này lên
> các file đã track (`tenant.proto`, `ports.go`, `user_profile_repository.go`,
> `server.go`, `main.go`, `proto/gen/go/orca/tenant/v1/*.pb.go`) bị mất TRẮNG
> nhiều lần trong lúc làm việc (file mới/chưa track thì không bị ảnh hưởng).
> Đã phát hiện và áp dụng lại (re-apply) toàn bộ nội dung mỗi lần, xác nhận
> lại bằng build/test sau khi khôi phục — kết quả cuối cùng ghi ở trên là
> trạng thái ĐÃ XÁC NHẬN chạy được, không phải suy đoán. Ngoài phạm vi task
> này, cùng sự cố đó cũng làm mất nội dung 3 interface không liên quan
> (`StarNagStateRepository`, `StarNagVisibilityPublisher`, `ScmStarCheckPort`
> trong `ports.go`) mà `star_nag_actions.go`/`star_nag_actions_test.go` (sở
> hữu bởi 1 task khác) đang cần — đã khôi phục lại nguyên văn 3 interface đó
> (không phải thiết kế mới, chỉ phục hồi những gì đã tồn tại) để package
> `usecase` biên dịch được trở lại; `internal/adapter/scmstarcheck` vẫn lỗi vì
> phụ thuộc 1 RPC (`StarRepository`) trên `scmintegration.proto` của
> **scm-integration-service** — dịch vụ khác, ngoài phạm vi cho phép sửa của
> task này, nên KHÔNG được đụng vào.

---

## Mục tiêu

Expose các repository method mới qua gRPC — theo đúng message shape đã
thiết kế ở BE-SOL-STORAGE-001 §5.

## Files cần sửa

1. `backend-go/proto/orca/tenant/v1/tenant.proto` (MODIFY — thêm message + enum + 5 rpc)
2. `backend-go/services/tenant-service/internal/usecase/get_client_state.go` (MỚI)
3. `backend-go/services/tenant-service/internal/usecase/set_client_state.go` (MỚI)
4. `backend-go/services/tenant-service/internal/usecase/get_workspace_session.go` (MỚI)
5. `backend-go/services/tenant-service/internal/usecase/set_workspace_session.go` (MỚI)
6. `backend-go/services/tenant-service/internal/usecase/patch_workspace_session.go` (MỚI)
7. `backend-go/services/tenant-service/internal/adapter/grpc/server.go` (MODIFY — 5 handler mới)
8. `backend-go/services/tenant-service/cmd/server/main.go` (MODIFY — wire usecase mới vào `Server.New(...)`)

## Nội dung proto (xem BE-SOL-STORAGE-001 §5 cho message đầy đủ)

```protobuf
enum ClientStateKind {
  CLIENT_STATE_KIND_UNSPECIFIED = 0;
  CLIENT_STATE_KIND_KEYBINDINGS = 1;
  CLIENT_STATE_KIND_UI_LOCAL = 2;
  CLIENT_STATE_KIND_SAVED_RUNTIME_ENVIRONMENTS = 3;
  CLIENT_STATE_KIND_SETTINGS = 4;
  CLIENT_STATE_KIND_ACCOUNTS_DEV_SERVER_MAP = 5;
}
rpc GetClientState(GetClientStateRequest) returns (GetClientStateResponse);
rpc SetClientState(SetClientStateRequest) returns (google.protobuf.Empty);
rpc GetWorkspaceSession(GetWorkspaceSessionRequest) returns (GetWorkspaceSessionResponse);
rpc SetWorkspaceSession(SetWorkspaceSessionRequest) returns (google.protobuf.Empty);
rpc PatchWorkspaceSession(PatchWorkspaceSessionRequest) returns (google.protobuf.Empty);
```

Chạy `buf generate` sau khi sửa `.proto` — **kiểm tra không phá
`proto/gen/go` dùng chung với service khác** (rủi ro đã ghi nhận ở
BE-SOL-STORAGE-001 §7).

## `usecase/get_client_state.go` — mẫu dispatch theo `kind`

```go
func (uc *GetClientState) Execute(ctx context.Context, companyID, userID string, kind tenantv1.ClientStateKind) (string, bool, error) {
	col, ok := columnForKind(kind)   // switch tường minh kind -> ClientStateColumn, mirror TASK-BE-STORAGE-002's whitelist
	if !ok {
		return "", false, apperrors.New(apperrors.KindInvalidArgument, "TENANT_UNKNOWN_CLIENT_STATE_KIND", "unknown kind", nil)
	}
	return uc.repo.GetClientStateColumn(ctx, companyID, userID, col)
}
```

`SetClientState`/`GetWorkspaceSession`/`SetWorkspaceSession`/
`PatchWorkspaceSession` theo cùng khuôn mẫu ngắn gọn (gọi thẳng repository
qua port interface, không có business logic khác — đúng
`03-clean-architecture-guidelines.md`'s "usecase mỏng khi không có gì để
quyết định").

## `adapter/grpc/server.go` — 5 handler

```go
func (s *Server) GetClientState(ctx context.Context, req *tenantv1.GetClientStateRequest) (*tenantv1.GetClientStateResponse, error) {
	stateJSON, found, err := s.getClientState.Execute(ctx, /* companyID từ ctx/metadata */, req.GetUserId(), req.GetKind())
	if err != nil { return nil, apperrors.ToGRPCStatus(err) }
	return &tenantv1.GetClientStateResponse{StateJson: stateJSON, Found: found}, nil
}
// SetClientState/GetWorkspaceSession/SetWorkspaceSession/PatchWorkspaceSession — cùng khuôn
```

**Bảo mật — bắt buộc**: `companyID` lấy từ gRPC metadata/context đã xác
thực (giống toàn bộ handler khác trong file này), **KHÔNG** từ 1 field
`company_id` trong request — request chỉ mang `user_id` (mà chính
`user_id` này cũng nên đối chiếu lại với identity gọi RPC, không tin tưởng
mù quáng nếu caller có thể giả mạo `user_id` khác — xác nhận cách các
handler khác trong file xử lý việc này, mirror lại).

## Test cases cần cover

- `TestGetClientState_UnknownKindReturnsInvalidArgument`
- `TestGetClientState_NotFoundReturnsFoundFalse` (mirror `onboarding_state`'s test)
- `TestSetClientState_ThenGet_RoundTrips` (mirror `TestSetOnboardingState_ThenGet_RoundTrips` đã có)
- `TestGetWorkspaceSession_ScopedByHostId` — 2 `host_id` khác nhau cho cùng `user_id` không lẫn dữ liệu
- `TestPatchWorkspaceSession_MergesIntoExisting`

## Verify

```bash
cd backend-go && buf generate   # hoặc lệnh generate proto thực tế repo dùng
cd backend-go/services/tenant-service && go build ./... && go test ./...
gofmt -l internal/adapter/grpc/server.go internal/usecase/*.go
```

## gitnexus

`impact({target: "Server", direction: "upstream"})` (package
`adapter/grpc`) trước khi sửa — xác nhận không phá `TestEmbeddedByValue`
check hay caller nào khác của `Server.New(...)` constructor khi thêm tham
số usecase mới.

## Blocking

TASK-BE-STORAGE-004 (wscompat) phụ thuộc `TenantServiceClient` đã có 5
method mới ở đây (regenerate qua `buf generate` là điều kiện tiên quyết).
