# FE-TASK-STORAGE-014: `connectivity-status.ts` (slice mới) + poll trigger

**Solution:** FE-SOL-STORAGE-006 | **CR:** CR-STORAGE-007
**Depends on:** [TASK-BE-STORAGE-008](../../../../backend-go/crs/v3/storage/tasks/TASK-BE-STORAGE-008-wscompat-connectivity-and-agent-session-channels.md) (backend-go), FE-TASK-STORAGE-004 (`persistence-status.ts` để mở rộng)
**Status:** ✅ DONE (2026-09-07)

> **Kết quả thực tế:**
> - `connectivity-status.ts` (MỚI): `ConnectivitySlice` đúng shape thiết kế
>   (`connections: Record<connectionId, {status, lastActivityAt?, degradedSince?}>`,
>   `pollConnectivitySummary(target: RuntimeClientTarget)`) — khớp field-for-field
>   với `connectionHealthView` thật trong `channels_infra_fleet.go`
>   (camelCase `connectionId`/`devServerId`/`status`/`lastActivityAt`/`degradedSince`,
>   2 field cuối omitempty giữ nguyên "unset", không coerce về 0).
>   `pollConnectivitySummary` tự bắt lỗi (console.warn), không throw ra ngoài —
>   chạy off 1 timer không có UI nào chờ promise reject, và giữ nguyên
>   `connections` cũ thay vì xoá về `{}` khi poll thất bại.
> - Phân loại lỗi: `isConnectivityLikeRpcError(err)` — check
>   `RuntimeRpcCallError.code` thuộc 1 set các code timeout/transport
>   (`timeout`/`not_connected`/`agent_not_connected`/`unreachable`/
>   `connection_closed`/`relay_starting`/`worker_cold`) HOẶC message khớp các
>   pattern timeout — mirror đúng `isRetryable` check đã có trong
>   `remote-runtime-pty-transport.ts`'s `callRuntimeWithColdStartRetry`
>   (tiền lệ có sẵn cho đúng bài toán "connectivity vs. logic error" này).
>   `maybeTriggerConnectivityPollAfterRpcFailure(err, target)` chỉ trigger poll
>   khi classifier trả `true`.
> - 3 trigger: (1) 30s interval + (2) app-foreground-return gộp vào 1 hàm
>   `installConnectivityPolling()` xuất từ `connectivity-status.ts`, tái dùng
>   `installWindowVisibilityInterval` (`lib/window-visibility-interval.ts`) —
>   helper dùng chung sẵn có cho đúng combo "interval + rerun khi visible"
>   (đã dùng ở `WorktreeCard.tsx`, `ChecksPanel.tsx`, `useNow.ts`, v.v.) — thay
>   vì tự viết 1 `visibilitychange` listener thứ 2 cạnh 1 `setInterval` thứ 2.
>   (3) RPC-write-failure trigger là `maybeTriggerConnectivityPollAfterRpcFailure`,
>   gọi trực tiếp từ catch block của call site (ngoài phạm vi file list của
>   task này — mỗi call site RPC ghi hiện có là việc của call site đó, không
>   sửa toàn bộ codebase ở đây).
> - **Rà soát trước khi thêm interval** (theo yêu cầu bắt buộc của task):
>   `stats.ts`/`preflight.ts` (2 file task doc gợi ý) **không có** poll
>   interval nào của riêng chúng — không có gì để gộp vào. 2 hook
>   `use-fleet-health-polling.ts`/`useFleetHealthPolling.ts` (2 file trùng tên
>   khác thư mục) polling khác domain (SSH fleet reachability qua
>   `fleet.health.checkAll`/`window.api.ssh.getFleetHealth`, không phải
>   per-connection dev-server connectivity qua `connectivity.getSummary`) —
>   không phù hợp gộp chung. `ConnectionStatusProvider.tsx` cũng khác domain
>   (transport-level `client.isConnected()`, 2s, chỉ web mode). Thay vào đó
>   tái dùng `installWindowVisibilityInterval` — cơ chế dùng chung THẬT của
>   codebase cho pattern này — wire trực tiếp vào 1 `useEffect` mới ở
>   `App.tsx` (không có file "polling-init" riêng nào tồn tại).
> - `persistence-status.ts`: **không sửa.** `PersistenceStatusSlice` hiện tại
>   được thiết kế riêng cho write-path (zustand `persist` → backend-go
>   `ClientStateKind`, xem doc comment gốc của file: "backend-go-storage.ts's
>   withRetryAndErrorStatus writes here"), không phải health-status chung cho
>   mọi subsystem. FE-TASK-STORAGE-013 (cùng nhóm CR-STORAGE-006) đã xác nhận
>   tiền lệ này — không ép `ssh.ts`/`provisioning.ts` hydrate-read errors vào
>   `persistenceStatus`. `connectivity.getSummary` cũng là read-path (không
>   phải 1 `ClientStateKind` thật trên backend), và FE-SOL-STORAGE-006 §5
>   không hề gọi `persistenceStatus` cho connectivity-status.ts (chỉ §1's
>   `dev-servers.ts` pseudocode có, thuộc FE-TASK-STORAGE-012, chưa làm).
>   Theo cùng lý do, không mở namespace `devServers`/`agentSessions`/`sshFleet`
>   giả vào `ClientStateKind` ở đây.
> - `gitnexus`: `impact({target: "AppState", direction: "upstream", repo: "orca"})`
>   → `Target 'AppState' not found`. Xác nhận đây là hạn chế thật của GitNexus
>   index cho repo này (không phải index cũ) — `context({name: "PersistenceStatusSlice"})`
>   (1 type alias đã tồn tại từ lâu, không phải do task này) cũng trả "not found" —
>   type alias thuần (không phải class/interface) không được index. Không có
>   cách nào chạy được impact() thật cho `AppState` với index hiện tại; báo lại
>   thay vì bỏ qua bước này.
> - Verify: `cd frontend && npx vitest run src/renderer/src/store/slices/connectivity-status.test.ts`
>   → **10/10 pass** (4 test files nhóm: pollConnectivitySummary [3],
>   isConnectivityLikeRpcError [3], maybeTriggerConnectivityPollAfterRpcFailure [2],
>   installConnectivityPolling [2]). `tsc --noEmit` xác nhận 0 lỗi type mới ở
>   5 file đã sửa (baseline repo đã có nhiều lỗi type không liên quan từ trước).

---

## Mục tiêu

Slice mới lưu trạng thái connectivity từng connection, poll theo 3 trigger:
app foreground trở lại, mỗi 30s khi app mở, ngay sau 1 RPC ghi thất bại
nghi do mất kết nối.

## Files cần sửa

1. `frontend/src/renderer/src/store/slices/connectivity-status.ts` (MỚI)
2. `frontend/src/renderer/src/store/slices/persistence-status.ts` (MODIFY — thêm namespace `devServers`/`agentSessions`/`sshFleet`)
3. `frontend/src/renderer/src/store/types.ts` (MODIFY — thêm `ConnectivitySlice` vào `AppState`)
4. `frontend/src/renderer/src/store/index.ts` (MODIFY — đăng ký slice)
5. Nơi khởi tạo poll interval (App root component) — MODIFY
6. Test file tương ứng

## Nội dung (xem FE-SOL-STORAGE-006 §5 cho code đầy đủ)

```ts
interface ConnectivitySlice {
  connections: Record<string, { status: 'establishing'|'established'|'degraded'|'closed'; lastActivityAt?: number; degradedSince?: number }>
  pollConnectivitySummary: (target: RuntimeTarget) => Promise<void>
}
```

**Trước khi thêm interval mới**: rà soát `stats.ts`/`preflight.ts` xem đã
có poll interval nào cùng mục đích "theo dõi trạng thái kết nối" chưa
(rủi ro đã ghi trong solution) — nếu có, cân nhắc gộp chung 1 interval
thay vì thêm interval thứ 2 độc lập.

## Test cases cần cover

- `pollConnectivitySummary` set đúng `connections` theo response
  `connectivity.getSummary`, keyed đúng `connectionId`.
- Poll trigger đúng 30s (fake timers) khi app đang mở.
- Poll trigger khi app foreground trở lại (mock `visibilitychange` event).
- Poll trigger sau 1 RPC ghi thất bại **có `err.code`/timeout phù hợp**,
  KHÔNG trigger cho lỗi logic thông thường (viết rõ điều kiện phân biệt 2
  loại lỗi này trong code, có test riêng cho từng nhánh).

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/store/slices/connectivity-status.test.ts
```

## gitnexus

`impact({target: "AppState"})` sau khi thêm slice mới vào `types.ts`.

## Blocking

Không thiết kế UI banner ở task này (ngoài phạm vi solution) — chỉ đảm
bảo dữ liệu có trong store.
