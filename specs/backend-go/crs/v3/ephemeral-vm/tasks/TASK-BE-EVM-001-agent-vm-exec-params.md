# TASK-BE-EVM-001: Bổ sung `recipeId`/`runtimeId` vào params `vm.exec`

**Solution:** [BE-SOL-EVM-001](../solutions/BE-SOL-EVM-001-agent-vm-exec-params.md) | **CR:** CR-EVM-001
**Service:** `infra-fleet-service`
**Depends on:** Không
**Status:** ✅ DONE — 2026-09-08

---

**Kết quả thực tế:** Implement đúng như sketch, với 2 lệch đáng chú ý.

- `ephemeral_vm_relay.go`: `SuspendWorkspace`/`ResumeWorkspace` đã có sẵn
  `recipeId`/`runtimeId` trong params `vm.exec` trước khi task này bắt đầu
  soát lại (không cần sửa 2 call site đó). `CleanupWorkspace` đã có sẵn
  bước `uc.runtimes.Get(ctx, tenantID, runtimeID)` trước khi build params,
  đúng khớp sketch — code hiện có trên disk đã phản ánh đúng nội dung task
  này mô tả khi bắt đầu thực thi trực tiếp.
- **Lệch #1**: `uc.runtimes.Get(ctx, tenantID, id)` KHÔNG có sẵn trên
  `EphemeralVmRuntimeRepository` interface trước task này — phải thêm
  `Get` vào interface (`list_ephemeral_vm_runtimes.go`) và implement thật
  trong `internal/adapter/postgres/ephemeral_vm_runtime_repository.go`
  (query by `tenant_id + id`, loại `status = 'destroyed'`, mirror y hệt
  `GetByWorkspaceID`'s pattern) — ngoài phạm vi "Files cần sửa" gốc (chỉ
  liệt kê `ephemeral_vm_relay.go`) nhưng bắt buộc để sketch compile được.
- **Lệch #2**: test fake `fakeDevServerAgentClient` (dùng chung nhiều
  usecase test khác, `scan_workspace_ports_test.go`) trước đó chỉ ghi lại
  `execCalls []string` (tên method), không ghi `params` — không đủ để
  assert `recipeId`/`runtimeId` thật sự có trong params gửi đi. Thêm field
  `execParams []map[string]any` (song song với `execCalls`, cùng index)
  để 3 test case mới có thể assert nội dung params.
- Test hiện có `TestEphemeralVmRelay_CleanupWorkspace_WithCommand_RelaysThenDestroys`
  cần sửa (thêm `byID: {"rt-1": {...RecipeID: "recipe-1"}}` vào fake
  repository) vì `CleanupWorkspace` giờ gọi `runtimes.Get` trước — không
  sửa sẽ regress (Get trả `ErrEphemeralVmRuntimeNotFound` do fake rỗng).
- Tên test dùng đúng tiền tố `TestEphemeralVmRelay_` theo convention có
  sẵn của file (khác chữ hoa/thứ tự nhẹ so với tên gợi ý trong "Test cases
  cần cover", giữ nguyên ý nghĩa): `TestEphemeralVmRelay_SuspendWorkspace_SendsRecipeIdAndRuntimeIdToAgent`,
  `TestEphemeralVmRelay_ResumeWorkspace_SendsRecipeIdAndRuntimeIdToAgent`,
  `TestEphemeralVmRelay_CleanupWorkspace_LoadsRuntimeBeforeCallingAgent`.
  Thêm 1 test nữa ngoài yêu cầu gốc:
  `TestEphemeralVmRelay_CleanupWorkspace_UnknownRuntimeID_NotFoundBeforeAgentCall`
  (tách riêng khỏi test "loads runtime" ở trên để cô lập rõ nhánh lỗi
  `INFRA_EPHEMERAL_VM_RUNTIME_NOT_FOUND` + xác nhận agent không hề được
  gọi).
- gitnexus: `codegraph explore` xác nhận `SuspendWorkspace`/`ResumeWorkspace`/
  `CleanupWorkspace` chỉ có caller từ `server_ephemeral_vm.go` (gRPC
  adapter) + test file — không có caller nào khác phụ thuộc chữ ký hoặc
  nội dung params cụ thể. Risk thấp, khớp đánh giá gốc của task.

**Verify thật đã chạy:**
```
cd backend-go/services/infra-fleet-service && go build ./...                        # sạch
go test ./internal/usecase/... -run EphemeralVm -v                                  # 15/15 PASS, không regress
gofmt -l .                                                                            # sạch
```
Ngoài ra chạy `go build ./...` cho toàn bộ 19 module trong `go.work` (bao
gồm `infra-fleet-service`) — không module nào vỡ build vì thay đổi này.

## Mục tiêu

Thêm `recipeId`/`runtimeId` vào params 3 call site `vm.exec` hiện có, và
thêm 1 read `EphemeralVmRuntime` còn thiếu trong `CleanupWorkspace`.

## Files cần sửa

1. `backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go` (MODIFY — `SuspendWorkspace`:98, `ResumeWorkspace`:121, `CleanupWorkspace`:152)

## Nội dung (xem BE-SOL-EVM-001 cho chi tiết)

```go
// SuspendWorkspace/ResumeWorkspace — runtime đã load qua GetByWorkspaceID, dùng ngay
uc.callAgent(ctx, devServer, "vm.exec", map[string]any{
  "repoPath": repoPath, "command": command, "phase": "suspend",
  "recipeId": runtime.RecipeID, "runtimeId": runtime.ID,
})

// CleanupWorkspace — THÊM 1 bước load runtime trước khi build params
runtime, err := uc.runtimes.Get(ctx, tenantID, runtimeID)
if err != nil {
  return domain.EphemeralVmRuntime{}, apperrors.New(apperrors.KindNotFound, "INFRA_EPHEMERAL_VM_RUNTIME_NOT_FOUND", "runtime not found", err)
}
// ... build params với runtime.RecipeID, runtimeID
```

## Test cases cần cover

- `TestSuspendWorkspace_SendsRecipeIdAndRuntimeIdToAgent`
- `TestResumeWorkspace_SendsRecipeIdAndRuntimeIdToAgent`
- `TestCleanupWorkspace_LoadsRuntimeBeforeCallingAgent` — xác nhận `runtimes.Get` được gọi trước `callAgent`, và lỗi `INFRA_EPHEMERAL_VM_RUNTIME_NOT_FOUND` đúng khi `runtimeID` không tồn tại
- Test hiện có (`TestSuspendWorkspace_*`/`TestResumeWorkspace_*`/`TestCleanupWorkspace_*`) không được regress

## Verify

```bash
cd backend-go/services/infra-fleet-service && go build ./... && go test ./internal/usecase/... -run EphemeralVm
gofmt -l .
```

## gitnexus

`impact({target: "EphemeralVmRelay", direction: "upstream"})` trước khi
sửa — xác nhận không có caller nào khác ngoài wscompat's `channels_ephemeral_vm.go`
phụ thuộc đúng 3 chữ ký hiện có của `SuspendWorkspace`/`ResumeWorkspace`/
`CleanupWorkspace` (chữ ký không đổi ở task này, chỉ nội dung params gửi
đi thay đổi — rủi ro thấp nhưng vẫn xác nhận trước khi sửa).

## Blocking

Không task nào trong nhóm ephemeral-vm phụ thuộc cứng vào task này —
nhưng nên làm song song/trước
[TASK-AG-EVM-001](../../../../agent/crs/v3/ephemeral-vm/tasks/TASK-AG-EVM-001-vm-exec-handler.md)
để merge cùng lúc (tên field JSON phải khớp 1:1 giữa 2 phía).
