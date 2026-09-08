# FE-SOL-EVM-001: Gỡ `ephemeralVm` khỏi `DESKTOP_ONLY_NAMESPACES` + audit routing 9 method đã port

> **🔲 Designed — chưa implement.** Sửa 1 lỗi phân loại đã lỗi thời —
> không phải thiết kế mới.

**CR:** [CR-EVM-002](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-002-remove-stale-desktop-only-suppressor.md)
**TDD tham chiếu:** [TDD-FE-03](../../../../tdd/v5/03-runtime-client-layer.md) §2 (Runtime RPC Client — `callRuntimeRpc`, cơ chế routing dùng ở đây)

---

## 1. Xác nhận granularity thật của suppressor trước khi gỡ

`desktop-only-rpc-error-suppressor.ts:70-72` khai báo
`DESKTOP_ONLY_NAMESPACES: ReadonlySet<string>` — khoá theo **namespace**
(`'ephemeralVm'`), không theo method riêng lẻ. Vì 9/12 method của
namespace này giờ đã có backend thật nhưng 3 method
(`provision`/`cancelProvision`/`onProvisionEvent`) thì chưa (cho tới khi
[FE-SOL-EVM-002](./FE-SOL-EVM-002-provision-streaming-client.md) ship),
gỡ cả namespace sẽ làm 3 method đó phát sinh console error mới — cần xử
lý granularity method-level ngay trong solution này (không đợi
FE-SOL-EVM-002), theo 1 trong 2 hướng:

- **(a)** Đổi `DESKTOP_ONLY_NAMESPACES` từ `Set<string>` (namespace) sang
  hỗ trợ khoá theo `"namespace.method"` cho các trường hợp namespace bị
  chia đôi trạng thái như thế này (thay đổi kiểu dữ liệu, ảnh hưởng mọi
  entry hiện có — rủi ro lan rộng hơn).
- **(b)** Giữ nguyên khoá theo namespace, nhưng **gỡ hẳn** `'ephemeralVm'`
  ngay bây giờ và chấp nhận 3 console error mới cho `provision`/... cho
  tới khi FE-SOL-EVM-002 ship — đơn giản hơn, đúng tinh thần "lỗi thật
  phải hiển thị" của CR-EVM-002, và 3 lỗi đó có thời hạn ngắn (chỉ tới
  khi FE-SOL-EVM-002 xong).

**Khuyến nghị: hướng (b)** — không đổi kiểu dữ liệu của suppressor cho 1
trường hợp tạm thời; 3 console error trong lúc chờ FE-SOL-EVM-002 chấp
nhận được, và tự biến mất khi solution đó ship (không cần dọn lại
suppressor lần 2).

## 2. Gỡ khỏi danh sách

```ts
// desktop-only-rpc-error-suppressor.ts:70-72
const DESKTOP_ONLY_NAMESPACES: ReadonlySet<string> = new Set([
  // ... các namespace khác giữ nguyên ...
- 'ephemeralVm',
])
```

## 3. Audit routing 9 method đã port — so khớp field-by-field

`runtime-ephemeral-vm-client.ts:14-109`'s hybrid routing (`if (target.kind
=== 'local') { window.api... } return callRuntimeRpc(target,
'ephemeralVm.X', ...)`) đã đúng shape gọi (`callRuntimeRpc`, theo TDD-FE-03
§2). Rủi ro thật không nằm ở cơ chế gọi mà ở **response shape** — đây là
2 codebase độc lập (TS frontend, Go backend-go) cùng implement 1 contract
JSON, dễ lệch field mà compiler không bắt được. Cần audit từng cặp:

| Frontend decode | Backend-go response type | Việc cần làm |
|---|---|---|
| `listRuntimeEphemeralVmRecipes` | `ephemeralVmRecipeView` (`channels_ephemeral_vm.go:19-28`) | So khớp field JSON (`id`/`name`/`description`/`create`/`suspend`/`resume`/`destroy`/`destroyDisabled`) với type TS frontend decode — field optional (`omitempty` phía Go) phải khớp `?:` phía TS |
| `listRuntimeEphemeralVmRecipeCatalog` | `ephemeralVmCatalogEntry` (`channels_ephemeral_vm.go:346-`) | Tương tự |
| `attachRuntimeEphemeralVmWorkspace`/`suspendRuntimeEphemeralVmWorkspace`/`resumeRuntimeEphemeralVmWorkspace`/`cleanupRuntimeEphemeralVmWorkspace` | `domain.EphemeralVmRuntime` qua proto `EphemeralVmRuntime` message (`infrafleet.proto:207-`) | Xác nhận field `status`/`workspaceId`/`lastError`/... đúng tên/kiểu cả 2 phía — đây là type dùng bởi UI hiển thị trạng thái runtime, lệch field sẽ hiện `undefined` âm thầm, không lỗi rõ ràng |

Không viết test round-trip mới trong solution này nếu
`channels_ephemeral_vm_test.go` (backend-go) đã cover response shape đầy
đủ — chỉ cần đọc và xác nhận, viết thêm test frontend riêng nếu phát
hiện lệch thật.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| 3 console error tạm thời cho `provision`/`cancelProvision`/`onProvisionEvent` | Thấp, có thời hạn | Xem mục 1's hướng (b) — biến mất khi FE-SOL-EVM-002 ship |
| Lệch field response giữa 2 codebase (mục 3) | Trung bình | Không giả định khớp — audit thật là bắt buộc, không phải bước hình thức |

## Không thuộc phạm vi solution này

- Sửa bất kỳ lỗi thật nào bị phát lộ sau khi gỡ suppressor (đó là
  [SOL-AG-EVM-001](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-001-vm-exec-handler.md)
  và các solution khác) — solution này chỉ đảm bảo lỗi *được thấy*.
- `provision`/`cancelProvision` client — xem
  [FE-SOL-EVM-002](./FE-SOL-EVM-002-provision-streaming-client.md).

## Liên quan

- `frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts:20-27,63,70-72`
- `frontend/src/renderer/src/runtime/runtime-ephemeral-vm-client.ts:1-109`
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_ephemeral_vm.go`
- `specs/frontend/tdd/v5/03-runtime-client-layer.md` §2
