# BE-AUTO-SOL-001: Xác nhận routing 2-trục hiện tại + đóng 2 gap nhỏ

> **🔲 Designed — chưa implement.** Sau khi sửa lại kết luận sai của audit
> gốc (xem CR-AUTO-001's "Cập nhật 2026-09-09"), phần lớn solution này là
> **xác nhận + tài liệu hoá**, không phải code lớn.

**CR:** [CR-AUTO-001](../../../../../../docs/crs/v4/automations/CR-AUTO-001-consolidate-execution-backend.md)
**Frontend counterpart:** [FE-AUTO-SOL-001](../../../../frontend/crs/v4/automation/solutions/FE-AUTO-SOL-001-confirm-routing.md)
**Service:** `automation-service`, `api-gateway`
**TDD tham chiếu:** [`automation-service.md`](../../../../tdd/services/automation-service.md)

---

## 1. Trạng thái hiện tại (xác nhận, không phải thiết kế mới)

`automation-service` đã reachable thật từ renderer qua đường:
`automation-host-client.ts` (`target.kind === 'environment'`) →
`callRuntimeRpc` → `window.api.runtimeEnvironments.call` →
`api-gateway`'s wscompat `channels_automation_task.go` (`automation.list`/
`.create`/`.update`/`.delete`/`.runs`/`.runNow`, đã Register thật) →
`automation-service`'s gRPC server (`server.go`). Đường này **đã chạy
thật**, bằng chứng: `automation-host-client.ts:89-92`'s comment ghi lại 1
bug proto3-`omitempty` đã tìm và fix — không xảy ra được nếu đường này
chưa từng chạy.

**Không cần "chọn 1 backend canonical" theo nghĩa migration lớn** — kiến
trúc 2 trục (deployment target × pairing) đã hợp lý, nhất quán với
`ephemeralVm`/mọi domain remote khác trong repo.

## 2. Việc thật cần làm

### 2a. Xác nhận `run-target-resolution.ts`'s block không áp dụng sai phạm vi (phần backend-go)

Block hiện tại (`desktop/src/main/automations/run-target-resolution.ts:41-50`,
phía frontend/desktop) chặn automation Electron-local target remote host.
Về phía backend-go: xác nhận `automation-service`'s scheduler
(`ticker.go`) **không có giới hạn tương tự** — 1 automation tạo qua
pairing-path (backend-go) chạy dispatch tới bất kỳ dev server/target nào
`workflow-service.ExecuteAdHocStep` route được, không bị chặn theo kiểu
Electron-local. Đọc `workflow-service`'s dispatch target resolution
(`internal/adapter/infrafleetclient/relay_client.go`) để xác nhận điều
này — nếu đúng, không cần code gì thêm ở đây (chỉ ghi vào TDD/README
service để lần audit sau không lặp lại nhầm lẫn "3 bản triplicate").

### 2b. Ghi lại kiến trúc 2 trục vào `automation-service/README.md`

`README.md` hiện tại không giải thích rõ quan hệ với `desktop/src/main/automations/`
và `backend/src/main/automations/` (2 bản TS) — thêm 1 mục ngắn "Quan hệ
với automation TS (Electron/Node)" giải thích đúng 2 trục đã xác nhận ở
mục 1, trỏ sang CR-AUTO-001 để tránh lần audit sau lặp lại kết luận sai.

## 3. Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Mục 2a's giả định (`workflow-service` không chặn remote) chưa verify bằng code-reading trong solution này | Thấp | Cần đọc `relay_client.go` khi implement, không giả định suông |

## Không thuộc phạm vi solution này

- Migration dữ liệu automation cũ giữa các backend — không cần, vì
  không có "backend cũ cần thay thế", chỉ có 2 trục thiết kế hợp lệ song
  song.
- `actions[]` (action chain) — xem
  [BE-AUTO-SOL-002](./BE-AUTO-SOL-002-multi-action-chain-data-model.md).

## Liên quan

- `frontend/src/renderer/src/components/automations/automation-host-client.ts:81-98`
- `frontend/src/renderer/src/runtime/runtime-rpc-client.ts:50-73`
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_automation_task.go`
- `backend-go/services/workflow-service/internal/adapter/infrafleetclient/relay_client.go`
- `desktop/src/main/automations/run-target-resolution.ts:41-50`
