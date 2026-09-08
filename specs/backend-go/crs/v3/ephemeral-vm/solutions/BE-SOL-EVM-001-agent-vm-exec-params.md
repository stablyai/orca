# BE-SOL-EVM-001: Bổ sung `recipeId`/`runtimeId` vào params gửi cho `vm.exec`

> **🔲 Designed — chưa implement.** Đây là phần backend-go rất nhỏ đi kèm
> [CR-EVM-001](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-001-agent-vm-exec-handler.md)
> — phần việc chính (viết handler) nằm ở agent, xem
> [SOL-AG-EVM-001](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-001-vm-exec-handler.md).

**CR:** [CR-EVM-001](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-001-agent-vm-exec-handler.md)
**Service:** `infra-fleet-service`
**Agent counterpart:** [SOL-AG-EVM-001](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-001-vm-exec-handler.md)
**TDD tham chiếu:** [`infra-fleet-service.md`](../../../../tdd/services/infra-fleet-service.md) §7 (relay dispatch flow)

---

## 1. Vấn đề

`EphemeralVmRelay.SuspendWorkspace`/`ResumeWorkspace`/`CleanupWorkspace`
(`backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go:98,121,152`)
gọi `vm.exec` với params hiện tại:

```go
map[string]any{"repoPath": repoPath, "command": command, "phase": "suspend"}
```

Agent's `runRecipeCommand` (SOL-AG-EVM-001 tái dùng) cần build
`ORCA_VM_MODE`/`ORCA_VM_INSTANCE_ID`/`ORCA_RECIPE_ID`/`ORCA_REPO_PATH`
theo đúng contract recipe đã có (xem
`specs/backend/api/ephemeral-vm-server-mode-design.md`'s mục 33-35) —
nhưng `recipeId`/`instanceId` (= `runtimeId`) **không có mặt** trong
params hiện tại. Nếu recipe command dùng các biến này (nhiều recipe thật
sẽ dùng, ví dụ để tag VM cloud theo instance), việc thiếu chúng khiến
command chạy sai ngữ cảnh — một bug âm thầm khác, phát hiện khi chuẩn bị
solution này (không chỉ mỗi handler bị thiếu như CR-EVM-001 đã nêu).

## 2. Giải pháp

Thêm `recipeId`/`runtimeId` vào params gửi ở cả 3 call site
(`ephemeral_vm_relay.go:98,121,152`):

```go
uc.callAgent(ctx, devServer, "vm.exec", map[string]any{
  "repoPath":  repoPath,
  "command":   command,
  "phase":     "suspend", // hoặc "resume"/"destroy"
  "recipeId":  runtime.RecipeID,   // domain.EphemeralVmRuntime đã có field này
  "runtimeId": runtime.ID,
})
```

`domain.EphemeralVmRuntime` (xác nhận field `RecipeID`/`ID` có thật —
`backend-go/services/infra-fleet-service/internal/domain/ephemeral_vm_runtime.go:14-25`)
đã mang đủ dữ liệu cần:

- `SuspendWorkspace`/`ResumeWorkspace` đã gọi `runtimes.GetByWorkspaceID`
  trước khi tới bước `callAgent` — `runtime.RecipeID`/`runtime.ID` dùng
  được ngay, không cần thêm 1 read Postgres nào.
- `CleanupWorkspace` hiện **không** load `EphemeralVmRuntime` trước khi
  gọi `callAgent` (chỉ nhận `runtimeID` như 1 chuỗi, gọi thẳng
  `runtimes.UpdateStatus` ở cuối) — cần thêm 1 lời gọi
  `runtimes.Get(ctx, tenantID, runtimeID)` ở đầu hàm để lấy `RecipeID`
  trước khi build params cho `vm.exec`, đây là thay đổi duy nhất không
  chỉ "thêm field vào map có sẵn" trong solution này.

## 3. Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Backward-compat với agent build cũ chưa đọc 2 field mới | Không có | `vm.exec`'s params là `map[string]any` — thêm field không phá agent cũ (field bị bỏ qua nếu handler cũ không đọc tới) |
| Đồng bộ với SOL-AG-EVM-001 | Thấp | Cả 2 solution cần merge cùng lúc để `EphemeralVmRecipeContext`'s field name khớp 1:1 — xem SOL-AG-EVM-001 mục 2 |

## 4. Không thuộc phạm vi solution này

- Bản thân handler `vm.exec` ở agent — xem
  [SOL-AG-EVM-001](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-001-vm-exec-handler.md).
- `vm.provision` (mode `create`) — xem
  [BE-SOL-EVM-002](./BE-SOL-EVM-002-provision-streaming-channel.md).

## Liên quan

- `backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go:80-158`
- `backend-go/services/infra-fleet-service/internal/domain/` (`EphemeralVmRuntime` struct — xác nhận field `RecipeID` trước khi implement, tên field thật có thể khác)
- `specs/backend/api/ephemeral-vm-server-mode-design.md` (contract `ORCA_VM_*` env)
