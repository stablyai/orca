# CR-EVM-002 — Gỡ `ephemeralVm` khỏi frontend's `DESKTOP_ONLY_NAMESPACES`

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-EVM-002 |
| **Tên** | Gỡ `ephemeralVm` khỏi danh sách namespace "desktop-only, im lặng bỏ qua lỗi" đã lỗi thời |
| **Loại** | Bug Fix |
| **Priority** | P1 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-08 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Audit trực tiếp mã nguồn theo yêu cầu "ephemeralVm phải đảm bảo hoạt động ở frontend, backend-go và agent" |
| **Tác động HLD** | Frontend runtime-RPC layer |
| **Tác động Features** | Mọi UI dùng `ephemeralVm.*` khi target là remote/backend-go environment |

---

## Bối cảnh & Vấn đề gốc

`frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts`
tồn tại để im lặng bỏ qua lỗi RPC cho các namespace **biết trước** là
chỉ chạy trên desktop (không có backend nào phục vụ khi target là 1
remote environment) — tránh spam console error "expected" mỗi lần 1
web/paired client gọi 1 method chưa từng được port.

Comment đầu file (dòng 20-27) tự ghi rõ nguyên tắc:

```ts
// ... once a namespace's real backing store or RPC changes classification
// from "desktop-only" to "ported", remove it from `DESKTOP_ONLY_NAMESPACES`
```

Nhưng dòng 72 hiện tại vẫn còn:

```ts
const DESKTOP_ONLY_NAMESPACES: ReadonlySet<string> = new Set([
  ...
  'ephemeralVm',
  ...
])
```

Trong khi đó, `backend-go/services/api-gateway/internal/adapter/wscompat/channels_ephemeral_vm.go`
**đã đăng ký thật** 9 trong 12 channel của namespace này
(`listRecipes`, `listRecipeCatalog`, `doctor`, `listRuntimes`,
`attachWorkspace`, `suspendWorkspace`, `resumeWorkspace`, `cleanup`,
`getCleanupCommand` — xác nhận bằng grep `r.Register("ephemeralVm.` trên
file thật, không phải tài liệu cũ) — tức phân loại "desktop-only" đã sai
kể từ khi SOL-004/TASK-005 ship.

**Hệ quả cụ thể**: mọi lỗi RPC thật từ 9 method này — kể cả
`INFRA_EPHEMERAL_VM_UNSUPPORTED`/`INFRA_EPHEMERAL_VM_NO_CONNECTION` hợp
lệ, và kể cả [CR-EVM-001](./CR-EVM-001-agent-vm-exec-handler.md)'s lỗi
runtime đang chờ xảy ra — hiện bị dập tắt như thể "expected, desktop-only"
đối với bất kỳ ai đang dùng web/paired client với target là 1 remote
environment. Người dùng không thấy lỗi thật; việc debug CR-EVM-001 (nếu
làm trước CR này) cũng sẽ khó phát hiện qua UI.

## Giải pháp đề xuất

1. **Gỡ `'ephemeralVm'` khỏi `DESKTOP_ONLY_NAMESPACES`**
   (`desktop-only-rpc-error-suppressor.ts:72`).
2. **Audit lại đúng 9 method đã port**, xác nhận
   `runtime-ephemeral-vm-client.ts`'s hybrid-routing (`if (target.kind ===
   'local') { window.api... } return callRuntimeRpc(target, 'ephemeralVm.X',
   ...)`) hoạt động đúng end-to-end cho target `{kind: 'environment'}` —
   không chỉ compile được, mà thật sự gọi tới `channels_ephemeral_vm.go`
   và parse đúng response shape (`ephemeralVmRecipeView`/
   `ephemeralVmCatalogEntry`/... — so khớp field-by-field với type TS
   frontend đang decode, vì đây là 2 codebase độc lập cùng implement 1
   contract, dễ lệch field không được compiler bắt).
3. **3 method còn lại (`provision`/`cancelProvision`/`onProvisionEvent`)
   vẫn ở trong `DESKTOP_ONLY_NAMESPACES`** cho tới khi
   [CR-EVM-003](./CR-EVM-003-provision-streaming-rpc.md) ship — cần tách
   namespace `'ephemeralVm'` (hiện là 1 khối) thành danh sách method cụ
   thể nếu suppressor hiện chỉ hỗ trợ khoá theo namespace, không theo
   method — xem file thật để xác nhận granularity trước khi implement
   (nếu suppressor chỉ có namespace-level, CR-EVM-003 phải tự thêm logic
   suppress method-level cho riêng 3 method của nó khi ship, thay vì đợi
   CR này).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Console error mới xuất hiện cho 3 method chưa port (`provision`/...) nếu suppressor chỉ hỗ trợ namespace-level | Trung bình | Cần xác nhận granularity thật của suppressor trước khi gỡ cả namespace — nếu chỉ có namespace-level, phải đợi CR-EVM-003 ship trước, hoặc sửa suppressor sang method-level trong chính CR này |
| Phát lộ lỗi thật (kể cả CR-EVM-001's bug) ra UI | Thấp, đây là mục tiêu | Đúng ý định CR — lỗi thật phải hiển thị, không bị nuốt; cần đảm bảo UI hiển thị lỗi đó ở dạng thân thiện (không phải console spam trần trụi), không nằm ngoài phạm vi cải thiện UX lỗi |

## Không thuộc phạm vi CR này

- Sửa bất kỳ lỗi thật nào bị phát lộ sau khi gỡ suppressor (đó là
  [CR-EVM-001](./CR-EVM-001-agent-vm-exec-handler.md) và các CR khác) —
  CR này chỉ đảm bảo lỗi *được thấy*, không tự sửa nguồn gốc lỗi.

## Liên quan

- `frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts:20-27,63,72`
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_ephemeral_vm.go`
- `frontend/src/renderer/src/runtime/runtime-ephemeral-vm-client.ts:1-109`
- `specs/backend-go/bugs/missing-v3/BUG-004-ephemeralvm-channels-not-implemented.md` (trạng thái gốc trước khi SOL-004/TASK-005 ship — nay đã lỗi thời, chính là lý do CR này tồn tại)
