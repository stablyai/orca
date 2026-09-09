# BE-AUTO-SOL-006: Retention cấu hình được + timeout + concurrency guard

> **🔲 Designed — chưa implement.** Độc lập, không phụ thuộc solution
> nào khác trong nhóm.

**CR:** [CR-AUTO-007](../../../../../../docs/crs/v4/automations/CR-AUTO-007-retention-scheduler-hardening.md)
**Service:** `automation-service`
**TDD tham chiếu:** [`automation-service.md`](../../../../tdd/services/automation-service.md)

---

## 1. Trạng thái hiện tại

Không retention enforcement, không run timeout, không concurrency guard
ở `backend-go` — xác nhận qua đọc `ticker.go`/`repository.go`, khớp
`specs/backend-go/bugs/logic-v1/BUG-AT-02-chay-automation-schedule-partial.md`.

## 2. Giải pháp

### Retention cấu hình theo automation

```proto
message Automation {
  // ...
  int32 max_run_history = 11; // 0 = default 100
}
```
Prune ngay sau khi ghi `AutomationRun` mới (trong `run_now.go`/
`execute_automation_chain.go`), bằng 1 câu SQL `DELETE FROM automation_runs
WHERE automation_id = $1 AND id NOT IN (SELECT id FROM automation_runs
WHERE automation_id = $1 ORDER BY created_at DESC LIMIT $2)` — không load
hết run vào memory.

### Run timeout

`context.WithTimeout(ctx, timeout)` quanh dispatch loop (chain timeout,
không phải per-step — `workflow-service`'s `StepExecutors.ts`'s
`DEFAULT_TIMEOUT_MS` per-step timeout là khác tầng, giữ nguyên). Field
mới `run_timeout_seconds` trên `Automation`, default 7200 (2 giờ, khớp
BUG-AT-02).

### Concurrency guard

Cột `running_run_id` (nullable) trên `automations` table. Trước dispatch:
```sql
UPDATE automations SET running_run_id = $1
WHERE id = $2 AND (running_run_id IS NULL OR updated_at < now() - interval '3 hours')
RETURNING id
```
(điều kiện `updated_at < now() - interval '3 hours'` là tự-giải-phóng
nếu process crash giữa chừng không kịp release — TTL dài hơn
`run_timeout_seconds` mặc định để không tự giải phóng khi automation vẫn
đang chạy hợp lệ). 0 row trả về → automation đang chạy, trả lỗi rõ ràng
thay vì dispatch chồng. Release (`running_run_id = NULL`) khi run kết
thúc (thành công/lỗi/timeout) — trong `defer` ở dispatch loop.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| `running_run_id` TTL 3 giờ có thể quá dài/ngắn tuỳ actual timeout config | Thấp | Nên tính TTL = `run_timeout_seconds + buffer`, không hardcode 3 giờ độc lập với field đó |
| Prune SQL chạy trong hot path dispatch có thể chậm nếu automation có rất nhiều run | Thấp | Đã dùng `DELETE ... NOT IN (SELECT ... LIMIT)`, hiệu quả hơn cách TS side hiện làm — nhưng vẫn nên benchmark trước khi ship |
| Trùng đụng schema với BE-AUTO-SOL-002 (`automations`/`automation_runs` table) | Trung bình | Cả 2 solution đều ALTER cùng 2 bảng — nên gộp thành 1 migration nếu implement gần nhau, tránh 2 migration file chồng lấn |

## Không thuộc phạm vi solution này

- Timeout/retention cho automation TS (Electron/Node) — khác codebase,
  không thuộc backend-go.

## Liên quan

- `frontend/src/shared/automation-run-retention.ts:3` (đối chiếu hành vi TS, không copy 1:1)
- `backend-go/services/automation-service/internal/adapter/scheduler/ticker.go`
- `backend-go/services/automation-service/internal/adapter/postgres/repository.go`
- `specs/backend-go/bugs/logic-v1/BUG-AT-02-chay-automation-schedule-partial.md`
- [BE-AUTO-SOL-002](./BE-AUTO-SOL-002-multi-action-chain-data-model.md) (schema overlap, xem rủi ro)
