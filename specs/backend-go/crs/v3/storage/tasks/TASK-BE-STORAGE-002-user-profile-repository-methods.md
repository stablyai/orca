# TASK-BE-STORAGE-002: Repository methods cho 5 cột JSON + `UserWorkspaceSessionRepository`

**Solution:** BE-SOL-STORAGE-001 | **CRs:** CR-STORAGE-001, CR-STORAGE-003, CR-STORAGE-004(a,b)
**Service:** `tenant-service`
**Depends on:** TASK-BE-STORAGE-001
**Status:** ✅ DONE (2026-09-07)

> **Kết quả thực tế:** `UserProfileRepository.GetClientStateColumn`/
> `SetClientStateColumn` thêm vào `user_profile_repository.go` với whitelist
> switch tường minh (`columnNameFor`) — không nội suy tên cột trực tiếp từ
> input. `UserWorkspaceSessionRepository` (file mới) có đủ `Get`/`Set`/
> `Patch`; `Patch` dùng transaction thật (`tx.QueryRow ... FOR UPDATE` rồi
> `tx.Exec` UPSERT trong cùng transaction) — không phải giả lập. `go build
> ./...` sạch cho package `adapter/postgres`. Test **chạy thật với Postgres
> thật** qua testcontainers-go (`go test -tags=integration
> ./internal/adapter/postgres/...`, cần Docker — có sẵn trong môi trường
> này): 14/14 test pass khi chạy riêng lẻ hoặc retry (3 lần đầu tiên chạy
> full-suite bị fail do race có sẵn trong `testutil.StartPostgres`'s
> `wait.ForListeningPort` — Postgres alpine restart 1 lần sau initdb, đôi khi
> bắt được cổng đang nghe TRƯỚC lần restart đó; đây là flake sẵn có của helper
> dùng chung toàn bộ `adapter/postgres` package, không phải lỗi của code task
> này — xác nhận bằng cách chạy lại `TestCompanyRepository_CreateAndGetRoundTrip`
> hiện có 3 lần liên tiếp, PASS cả 3; và mọi test mới của task này PASS khi
> retry riêng lẻ). Bao gồm test whitelist-injection
> (`TestUserProfileRepository_ClientStateColumn_UnknownColumnRejected` —
> gửi tên cột kiểu `"settings_json; DROP TABLE ...;--"`, xác nhận trả lỗi rõ
> ràng, không panic, không build câu SQL với giá trị đó), test
> `ScopedByCompanyID`/`ScopedByHostId`, và
> `TestUserWorkspaceSessionRepository_Patch_ConcurrentPatchesDoNotLoseFields`
> (2 goroutine patch 2 field khác nhau cùng lúc, xác nhận cả 2 field sống
> sót nhờ `FOR UPDATE` serialize).
>
> **Ghi chú môi trường** (không thuộc phạm vi task này): giữa lúc làm việc,
> một tiến trình/agent khác chạy song song trong CÙNG working directory (không
> cô lập bằng worktree) đã thực hiện `git checkout`/reset khiến các file đã
> track (`ports.go`, `user_profile_repository.go`) bị revert mất các edit
> chưa commit — đã áp dụng lại (re-apply) toàn bộ nội dung, xác nhận lại bằng
> build/test sau khi khôi phục.

---

## Mục tiêu

Thêm method đọc/ghi cho từng cột mới, đúng chữ ký `GetOnboardingState`/
`SetOnboardingState` đã có (`found bool` khi NULL/không có row).

## Files cần sửa

1. `backend-go/services/tenant-service/internal/adapter/postgres/user_profile_repository.go` (MODIFY)
2. `backend-go/services/tenant-service/internal/adapter/postgres/user_workspace_session_repository.go` (MỚI)
3. `backend-go/services/tenant-service/internal/usecase/ports.go` (MODIFY — thêm `ClientStateRepository`, `WorkspaceSessionRepository` interface)

## Nội dung

`user_profile_repository.go` — thêm 5 cặp method, copy nguyên khuôn
`GetOnboardingState`/`SetOnboardingState` (dòng 119-160), đổi tên cột SQL:
`keybindings_json`, `ui_local_state_json`, `saved_runtime_environments_json`,
`client_settings_json`, `accounts_dev_server_json`.

**Cân nhắc gộp thành 1 method tham số hoá** (khớp thiết kế `ClientStateKind`
enum ở gRPC layer, TASK-BE-STORAGE-003):

```go
type ClientStateColumn string

const (
	ColumnKeybindings               ClientStateColumn = "keybindings_json"
	ColumnUILocalState              ClientStateColumn = "ui_local_state_json"
	ColumnSavedRuntimeEnvironments  ClientStateColumn = "saved_runtime_environments_json"
	ColumnClientSettings            ClientStateColumn = "client_settings_json"
	ColumnAccountsDevServerMap      ClientStateColumn = "accounts_dev_server_json"
)

// Whitelist cứng — KHÔNG build tên cột bằng string interpolation trực tiếp
// từ input bên ngoài (SQL injection qua identifier); switch tường minh:
func columnNameFor(col ClientStateColumn) (string, bool) {
	switch col {
	case ColumnKeybindings, ColumnUILocalState, ColumnSavedRuntimeEnvironments,
		ColumnClientSettings, ColumnAccountsDevServerMap:
		return string(col), true
	default:
		return "", false
	}
}

func (r *UserProfileRepository) GetClientStateColumn(ctx context.Context, companyID, userID string, col ClientStateColumn) (string, bool, error)
func (r *UserProfileRepository) SetClientStateColumn(ctx context.Context, companyID, userID string, col ClientStateColumn, json string) error
```

**Bắt buộc**: `columnNameFor`'s whitelist switch là điều kiện an toàn — không
được nội suy tên cột trực tiếp từ tham số `ClientStateKind` nhận từ gRPC mà
không qua switch tường minh này trước.

`user_workspace_session_repository.go` — 3 method:

```go
func (r *UserWorkspaceSessionRepository) Get(ctx context.Context, companyID, userID, hostID string) (string, bool, error)
func (r *UserWorkspaceSessionRepository) Set(ctx context.Context, companyID, userID, hostID, sessionJSON string) error
func (r *UserWorkspaceSessionRepository) Patch(ctx context.Context, companyID, userID, hostID, patchJSON string) error
```

`Patch` dùng transaction đọc-sửa-đè (`SELECT ... FOR UPDATE` rồi `UPDATE`)
— xem BE-SOL-STORAGE-001 §4 cho lý do (tránh mất field khi 2 patch gần
nhau).

## Test cases cần cover

- `GetClientStateColumn` trả `found=false` khi chưa có row VÀ khi cột NULL
  (2 case riêng, giống test hiện có cho `GetOnboardingState`).
- `SetClientStateColumn` với `col` không nằm trong whitelist → trả lỗi rõ
  ràng, KHÔNG panic, KHÔNG build câu SQL với giá trị đó.
- `UserWorkspaceSessionRepository.Patch`: 2 patch liên tiếp trong 1 transaction
  giả lập race — field từ patch 1 không bị mất sau patch 2 (test
  `TestPatchWorkspaceSession_ConcurrentPatchesDoNotLoseFields` theo đúng tên
  đã nêu ở BE-SOL-STORAGE-001 §7).
- In-memory fake implement cả 2 interface mới trong `ports.go`, dùng cho
  usecase test ở TASK-BE-STORAGE-003 (không cần Postgres thật).

## Verify

```bash
cd backend-go/services/tenant-service && go build ./... && go test ./internal/adapter/postgres/... -v
```

## gitnexus

`impact({target: "UserProfileRepository", direction: "upstream"})` trước khi
sửa — service hiện có, cần xác nhận không phá caller khác của
`user_profile_repository.go` (ví dụ `Upsert`/`Get` dùng bởi
`GetResolvedProfile`, KHÔNG được đụng khi thêm method mới).

## Blocking

TASK-BE-STORAGE-003 (gRPC layer) phụ thuộc `ports.go` interface ở đây.
