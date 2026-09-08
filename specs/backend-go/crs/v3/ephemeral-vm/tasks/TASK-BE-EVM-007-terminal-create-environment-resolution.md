# TASK-BE-EVM-007: `terminal.create` resolve `environmentId` bare

**Solution:** [BE-SOL-EVM-003](../solutions/BE-SOL-EVM-003-environment-devserver-resolution.md) §2 | **CR:** CR-EVM-004
**Service:** `infra-fleet-service`
**Depends on:** [TASK-BE-EVM-006](./TASK-BE-EVM-006-set-environment-id.md)
**Status:** ✅ DONE — 2026-09-08 (implement dù TASK-BE-EVM-006 đang BLOCKED — xem "Kết quả thực tế")

---

**Kết quả thực tế:** Task doc gốc ghi "Depends on: TASK-BE-EVM-006" và
README's dependency chain xếp 006 → 007 → 008 tuyến tính — nhưng đọc kỹ
lại thấy đây là phụ thuộc VỀ DỮ LIỆU (007 chỉ có ý nghĩa thật khi có hàng
`environment_id` thật để resolve), KHÔNG phải phụ thuộc VỀ CODE: logic
resolve `environmentId → dev_server_id` (1 SELECT có sẵn cột
`environment_id`, migration 0013 đã áp dụng từ trước) hoàn toàn độc lập
với việc AI GHI giá trị đó vào cột (006's câu hỏi kiến trúc còn treo).
Quyết định: implement 007 ngay, không chờ 006 — code đúng bất kể sau này
006 chốt hướng nào (runtimeID hay 1 devServerId khác), vì 007 chỉ ĐỌC
cột, không quan tâm ai/khi nào ghi vào.

- **Sketch's `req.EnvironmentId` không tồn tại** — task doc tự hedge
  ("nếu đã tồn tại") — đọc thật `SpawnTerminalSessionRequest`/`SpawnTerminalSessionInput`
  xác nhận KHÔNG có field `EnvironmentId` riêng. Cơ chế thật (đọc
  `spawn_terminal_session.go`'s `Execute` trước khi sửa): `ConnectionID`
  là 1 field polymorphic đã có sẵn 2 nhánh thử (real `infra.connections`
  row qua `ResolveConnection`, rồi fallback thử làm `devServerId` trực
  tiếp qua `DevServerRepository.Get` — tiền lệ `TestSpawnTerminalSession_ConnectionIDIsActuallyADevServerID_SpawnsAndPersists`).
  Thêm nhánh thứ 3 vào ĐÚNG chuỗi fallback này (không thêm field mới):
  nếu `devServers.Get` cũng fail, thử `FindDevServerByEnvironmentID`
  trước khi trả lỗi cuối.
- **Method tên khác sketch**: `FindDevServerByEnvironmentID` (task doc
  gợi ý) giữ nguyên, nhưng return shape là `(devServerID string, found
  bool, err error)` — không dùng sentinel error, theo đúng convention
  "Find*-style khác Get*-style" đã ghi trong doc comment (Get* trả
  `ErrEphemeralVmRuntimeNotFound`, Find* trả `found bool`).
- **`environment_id` == `dev_server_id` (BE-SOL-EVM-003 §1's design)** —
  `FindDevServerByEnvironmentID` chỉ cần xác nhận row TỒN TẠI (tenant-scoped,
  `status <> 'destroyed'`) rồi trả LUÔN chính `environmentID` input làm
  `devServerID` — không có cột dịch riêng nào.
- **Lỗi khi environmentId không resolve = `INFRA_TERMINAL_NO_COMPUTE_BOUND`**
  (KHÔNG PHẢI `INFRA_CONNECTION_NOT_FOUND` — đúng test case gốc yêu cầu),
  cùng mã lỗi nhánh `ConnectionID == ""` đã dùng — cùng 1 trạng thái
  "chưa có compute nào bound" về phía người dùng.
- **Thay đổi ngoài "Files cần sửa" gốc (2 file) — cần thêm 2 file nữa**:
  1. `internal/usecase/list_ephemeral_vm_runtimes.go` (MODIFY — thêm
     `FindDevServerByEnvironmentID` vào `EphemeralVmRuntimeRepository`
     interface, vì `SpawnTerminalSession` cần dependency mới này)
  2. `cmd/server/main.go` (MODIFY — `NewSpawnTerminalSession`'s chữ ký
     thêm tham số `ephemeralVmRuntimes EphemeralVmRuntimeRepository`;
     phải di chuyển `ephemeralVmRuntimeStore := infrapostgres.NewEphemeralVmRuntimeStore(pool)`
     lên sớm hơn trong file, trước `spawnTerminalSessionUC`, để có instance
     truyền vào — instance vẫn dùng lại y hệt ở khối "Ephemeral VM" bên
     dưới, không tạo 2 lần)
  3. `internal/usecase/spawn_terminal_session_test.go` (MODIFY — 8 call
     site `NewSpawnTerminalSession(...)` hiện có đều cần thêm 1 tham số)
  4. `internal/usecase/list_ephemeral_vm_runtimes_test.go` (MODIFY —
     `fakeEphemeralVmRuntimeRepository` thêm field `byEnvironmentID` +
     implement `FindDevServerByEnvironmentID`)
- gitnexus: `impact` MCP tool báo lỗi "Connection closed" khi gọi trực
  tiếp cho `SpawnTerminalSession` — fallback dùng `codegraph_explore`
  (xác nhận: `SpawnTerminalSession` có 3 caller — chính nó, generated
  grpc code, `server.go`'s handler — cộng 8 test hiện có; không interface
  nào khác implement `SpawnTerminalSession`, risk từ đổi constructor
  signature chỉ ảnh hưởng đúng 9 call site đã liệt kê ở trên, tất cả đã
  cập nhật).

**Test coverage** (3 test mới + 8 test hiện có không regress, tất cả
pass, kể cả dưới `-race`):
`TestSpawnTerminalSession_ResolvableEnvironmentIdFallsThroughToDevServerIdPath`,
`TestSpawnTerminalSession_UnresolvableEnvironmentIdReturnsNoComputeBound`,
`TestSpawnTerminalSession_EnvironmentIdScopedByTenant` (dùng 1 fake spy
riêng, `fakeEphemeralVmRuntimeRepositoryTenantSpy`, để xác nhận tenantID
thật sự được truyền qua — fake chung không tenant-namespace field
`byEnvironmentID` nên không tự chứng minh được scoping, spy này khẳng
định usecase luôn forward đúng tenantID cho query Postgres thật làm).

**Verify thật đã chạy:**
```
cd backend-go/services/infra-fleet-service && go build ./...                                          # sạch
go test ./internal/usecase/... ./internal/adapter/postgres/... -run EphemeralVm                        # PASS (đúng lệnh task doc)
go test ./internal/usecase/... -run SpawnTerminalSession -v                                            # 11/11 PASS
go test ./...                                                                                            # PASS toàn service
go test -race ./internal/usecase/... -run SpawnTerminalSession                                          # PASS, không race
gofmt -l .                                                                                                # sạch
```
`go build ./...` cho toàn bộ 19 module `go.work` — không module nào vỡ
build (constructor signature change không rò rỉ ra ngoài package
`usecase`/`cmd/server` — không service khác gọi `NewSpawnTerminalSession`).

## Mục tiêu

## Mục tiêu

`SpawnTerminalSession`'s resolution logic tra thêm 1 alias
`environmentId → dev_server_id` (qua `ephemeral_vm_runtimes.environment_id`)
trước khi gọi `ResolveConnection` — không đổi proto request, chỉ mở rộng
resolution phía server.

## Files cần sửa

1. `backend-go/services/infra-fleet-service/internal/usecase/spawn_terminal_session.go` (MODIFY)
2. `backend-go/services/infra-fleet-service/internal/adapter/postgres/ephemeral_vm_runtime_repository.go` (MODIFY — thêm `FindByEnvironmentID` hoặc tương đương)

## Nội dung (xem BE-SOL-EVM-003 §2)

```go
// spawn_terminal_session.go — trước bước ResolveConnection hiện có
if req.EnvironmentId != "" {
  devServerID, found, err := uc.ephemeralVmRuntimes.FindDevServerByEnvironmentID(ctx, tenantID, req.EnvironmentId)
  if err != nil { return ..., err }
  if !found {
    return nil, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_TERMINAL_NO_COMPUTE_BOUND", "environment has no compute bound yet", nil)
  }
  // tiếp tục nhánh dev_server_id alternate-key hiện có, dùng devServerID vừa resolve
}
```

**Không đổi** `SpawnTerminalSessionRequest`'s proto shape — field
`environmentId` (nếu đã tồn tại trong request hiện tại) chỉ đổi nguồn
tra cứu, không thêm field mới.

## Test cases cần cover

- `TestSpawnTerminalSession_ResolvableEnvironmentIdFallsThroughToDevServerIdPath`
- `TestSpawnTerminalSession_UnresolvableEnvironmentIdReturnsNoComputeBound` — hành vi hiện tại PHẢI giữ nguyên cho trường hợp chưa provision
- `TestSpawnTerminalSession_EnvironmentIdScopedByTenant` — không resolve nhầm sang runtime của tenant khác

## Verify

```bash
cd backend-go/services/infra-fleet-service && go build ./... && go test ./internal/usecase/... -run SpawnTerminalSession
```

## gitnexus

`impact({target: "SpawnTerminalSession", direction: "upstream"})` —
xác nhận rủi ro trước khi sửa, theo đúng cảnh báo `BACKLOG-002` đã ghi
("`spawn_terminal_session.go` đã ship và đang chạy đúng cho case dev
server thường — không được regress").

## Blocking

TASK-BE-EVM-008 dùng chung helper resolve `environmentId → dev_server_id`
task này tạo ra (`FindDevServerByEnvironmentID`) — nên hoàn thành trước
hoặc cùng lúc.
