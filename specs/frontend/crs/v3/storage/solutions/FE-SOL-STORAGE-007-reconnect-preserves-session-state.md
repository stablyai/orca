# FE-SOL-STORAGE-007: Tách auth-failure khỏi logout — giữ trạng thái khi đăng nhập lại

> **🔲 Designed — chưa implement.** Phần (a) độc lập, làm ngay được. Phần
> resume UX phụ thuộc
> [BE-SOL-STORAGE-003](../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-003-connection-reconnect-resume-contract.md)
> để dữ liệu reconnect-resume có ý nghĩa ở backend-go.

**CR:** [CR-STORAGE-008](../../../../../../docs/crs/v3/storage/CR-STORAGE-008-reconnect-resume-semantics.md)
**TDD tham chiếu:** [`specs/frontend/storage/browser-storage-catalog.md`](../../../../storage/browser-storage-catalog.md#4-auth--session--dev-server-connections)

---

## (a) `main-web-bootstrap.tsx` — auth-failure không còn `.clear()`

```ts
// frontend/src/renderer/src/web/main-web-bootstrap.tsx:92,97 — MODIFY
function handleAuthFailure() {
  // TRƯỚC: localStorage.clear(); sessionStorage.clear()
  // SAU: không xoá gì — token hết hạn/401/mất kết nối tạm thời không phải
  // ý định logout. orca.saved-instances / accountsDevServer / workspaceSession
  // giữ nguyên để khi đăng nhập lại, mọi state (kể cả dev-server/agent state
  // hydrate theo FE-SOL-STORAGE-006) khôi phục đúng như trước khi mất kết nối.
  redirectToLogin()
}
```

**Điều kiện bắt buộc — đổi user thì KHÔNG giữ state**: sau khi đăng nhập
lại thành công, so sánh `user_id` mới với `user_id` đã lưu cùng
`orca.web.workspaceSession.v1`/`orca.saved-instances` trước đó (thêm 1
field `ownerUserId` vào payload lưu, nếu chưa có). Nếu khác — coi như đổi
người dùng, chạy đúng luồng xoá như logout (mục b), **không** giữ lại state
của người dùng cũ. Đây là điều kiện an toàn bắt buộc, không phải tuỳ chọn.

## (b) `useLogout.ts` — thêm bước xác nhận + đóng session chủ động trước khi xoá

```ts
// frontend/src/renderer/src/hooks/useLogout.ts:50,55 — MODIFY
async function logout() {
  const confirmed = await showConfirmDialog({
    title: 'Đăng xuất',
    message: 'Thao tác này sẽ đóng mọi phiên terminal/agent đang chạy và quên các server đã lưu trên trình duyệt này.',
    confirmLabel: 'Đăng xuất và đóng mọi kết nối',
    cancelLabel: 'Huỷ'
  })
  if (!confirmed) return

  // MỚI — đóng chủ động phía backend-go TRƯỚC khi xoá state cục bộ, để
  // infra-fleet-service nhận đúng tín hiệu "đóng chủ động" (bỏ qua
  // grace-period, xem BE-SOL-STORAGE-003 mục 5) thay vì phải tự suy luận
  // từ việc mất kết nối đột ngột.
  await closeAllActiveSessions()   // gọi TeardownConnection cho mọi connectionId đang mở của user này

  localStorage.clear()
  sessionStorage.clear()
  redirectToLogin()
}

async function closeAllActiveSessions(): Promise<void> {
  const target = getActiveRuntimeTarget()
  if (target.kind !== 'environment') return   // desktop-local: không có connectionId nào cần đóng qua backend-go
  const { connections } = useAppStore.getState().connectivityStatus   // từ FE-SOL-STORAGE-006
  await Promise.allSettled(
    Object.keys(connections).map((connectionId) =>
      callRuntimeRpc(target, 'connection.teardown', { connectionId })
    )
  )
}
```

Không thêm dialog mới từ đầu nếu repo đã có 1 component confirm-dialog
dùng chung — dùng lại, không tạo `ConfirmDialog` thứ hai (theo nguyên tắc
đặt tên/tránh trùng lặp của `AGENTS.md`).

## (c) Resume UX sau khi đăng nhập lại

Không cần code mới ngoài (a) — vì `workspaceSession`/`saved-instances`/
`accountsDevServer` không bị xoá, luồng khởi động app hiện tại (đọc
localStorage → hydrate dev-server/agent state theo FE-SOL-STORAGE-006) tự
nhiên phục hồi đúng trạng thái. Điểm cần xác nhận khi implement: đảm bảo
luồng khởi động app **không** có 1 nhánh riêng nào giả định "vừa qua màn
hình login = trạng thái sạch" (ví dụ reset 1 số slice UI theo mặc định khi
thấy sự kiện login) — rà soát các listener trên sự kiện đăng nhập thành
công trước khi implement, không giả định trước.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/web/main-web-bootstrap.tsx` | MODIFY — bỏ `.clear()` khỏi auth-failure, thêm kiểm tra đổi user |
| `frontend/src/renderer/src/hooks/useLogout.ts` | MODIFY — thêm confirm dialog + `closeAllActiveSessions()` trước khi `.clear()` |

## Rủi ro / Cần xác nhận trước khi implement

| Hạng mục | Ghi chú |
|---|---|
| Phát hiện "đổi user" sau re-auth | Cần thêm field `ownerUserId` vào payload đã lưu nếu chưa có — audit lại `WorkspaceSessionState`/`OrcaInstance` shape trước khi thêm field mới |
| `connection.teardown` RPC | Cần xác nhận tên wscompat channel đúng với `TeardownConnection` gRPC đã có ở `infra-fleet-service` (API surface §3 TDD) — có thể cần đăng ký channel mới nếu chưa expose qua wscompat |
| Listener ẩn giả định "login = state sạch" | Cần audit riêng trước khi implement (a), không giả định trước — nếu có, phải gỡ hoặc điều kiện hoá theo "đây có phải lần đầu đăng nhập hay là resume sau auth-failure" |
| Trải nghiệm khi `closeAllActiveSessions()` chậm/timeout (dev server không phản hồi lúc logout) | Dùng `Promise.allSettled`, không chặn luồng logout — nếu 1 vài connection không đóng được kịp, backend-go vẫn có grace-period (BE-SOL-003) làm lưới an toàn, không để logout bị treo chờ mạng |

## Không thuộc phạm vi solution này

- Hành vi backend-go khi nhận `connection.teardown`/mất kết nối
  ngoài-ý-muốn — xem
  [BE-SOL-STORAGE-003](../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-003-connection-reconnect-resume-contract.md).
- Hydrate lại dữ liệu dev-server/agent sau khi đăng nhập lại — đã xử lý ở
  [FE-SOL-STORAGE-006](./FE-SOL-STORAGE-006-dev-server-agent-state-hydration.md),
  solution này chỉ đảm bảo dữ liệu **không bị xoá nhầm** trước đó.
- Desktop's `orca-data.json`/local logout behavior — không đổi, phạm vi
  CR-008 chỉ nêu 2 key web đã ghi nhận ở `browser-storage-catalog.md`.

## Liên quan

- `specs/frontend/storage/browser-storage-catalog.md` mục 4
- `frontend/src/renderer/src/web/main-web-bootstrap.tsx:92,97`
- `frontend/src/renderer/src/hooks/useLogout.ts:50,55`
- [FE-SOL-STORAGE-006](./FE-SOL-STORAGE-006-dev-server-agent-state-hydration.md)
- [BE-SOL-STORAGE-003](../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-003-connection-reconnect-resume-contract.md)
