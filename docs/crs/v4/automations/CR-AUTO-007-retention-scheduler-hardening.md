# CR-AUTO-007 — Retention cấu hình được + scheduler hardening (timeout, concurrency guard)

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-AUTO-007 |
| **Tên** | Retention "N run cuối" cấu hình theo automation + `backend-go` scheduler: run timeout, concurrency guard |
| **Loại** | Bug Fix / Hardening |
| **Priority** | P2 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Audit trực tiếp mã nguồn theo yêu cầu "rà soát F14 ở frontend và backend-go"; xác nhận lại `BUG-AT-02` |
| **Tác động HLD** | Automation domain, scheduler |
| **Tác động Features** | F14 (Automations) — tiêu chí chấp nhận "Cron automation chạy đúng giờ", retention |

---

## Bối cảnh & Vấn đề gốc

F14's tiêu chí chấp nhận
([`docs/features/F14-automations.md:76-81`](../../../features/F14-automations.md))
và mô tả "Retention policy: giữ N last runs" ngụ ý retention **cấu hình
được theo từng automation**. Audit xác nhận 2 vấn đề, khớp với
`specs/backend-go/bugs/logic-v1/BUG-AT-02-chay-automation-schedule-partial.md`'s
phát hiện trước đó:

1. **TS side hardcode, không cấu hình được**:
   `automation-run-retention.ts:3` —
   `MAX_AUTOMATION_RUNS_PER_AUTOMATION = 100`, áp dụng như nhau cho mọi
   automation, không có field nào trên `Automation` cho user chỉnh số
   này.
2. **`backend-go` không enforce retention nào** — không job/cron nội bộ
   nào prune `automation_runs` cũ.
3. **Không có run timeout** — BUG-AT-02 ghi nhận: automation chạy quá 2
   giờ không bị hủy, có thể treo vô thời hạn nếu action bên dưới (agent
   run, shell script) không tự timeout.
4. **Không concurrency guard giữa manual run và scheduled run cùng
   automation** — `ClaimDue`'s `SELECT ... FOR UPDATE SKIP LOCKED`
   (`internal/adapter/postgres/repository.go`) chỉ ngăn 2 scheduler tick
   claim trùng **cùng 1 lần đến hạn** (tránh double-fire khi có nhiều
   instance backend-go), nhưng không ngăn 1 user bấm "Run now" trong khi
   automation đó đang chạy do lịch — 2 run có thể chạy song song, dẫm
   lên nhau nếu action có side-effect không idempotent (vd. `create_pr`
   tạo 2 PR trùng).

## Giải pháp đề xuất

### Retention cấu hình theo automation

```proto
message Automation {
  // ... field hiện có ...
  int32 max_run_history = 11; // 0 = dùng default (100, giữ nguyên hành vi cũ)
}
```

`automation-run-retention.ts`'s `pruneAutomationRuns` nhận thêm param
`maxRuns` (đọc từ automation thay vì hằng số), default về 100 khi
`max_run_history == 0` — không đổi hành vi automation cũ không set field
này.

### `backend-go`: enforce retention

Thêm bước prune vào cuối `run_now.go`/`execute_automation_chain.go` (CR-AUTO-002)
sau khi ghi `AutomationRun` mới — theo đúng pattern TS đã làm (prune ngay
sau khi thêm run mới, không cần cron riêng), tránh thêm 1 background job
mới không cần thiết.

### Run timeout

Thêm `context.WithTimeout` (2 giờ, khớp giá trị BUG-AT-02 đề xuất, có thể
override per-automation qua field `run_timeout_seconds` tương tự
`max_run_history`) quanh lệnh gọi `workflow-service.ExecuteAdHocStep`
trong usecase dispatch — timeout ở tầng automation-service, không cần
sửa `workflow-service` (nó đã tự có timeout riêng cho từng step,
`StepExecutors.ts`'s `DEFAULT_TIMEOUT_MS = 30 * 60_000`, nhưng không có
timeout cho *toàn bộ chain* nhiều action — đây là gap khác, đúng scope
CR này).

### Concurrency guard

Thêm cột `running_lock` (boolean hoặc `current_run_id`) trên
`automations` table — trước khi dispatch (dù từ `RunNow` hay từ
scheduler's `evaluateDueRuns`), kiểm tra + set atomically (1 câu
`UPDATE ... WHERE running_lock = false RETURNING id` hoặc tương đương
advisory lock Postgres) — nếu automation đang chạy, `RunNow` trả lỗi rõ
ràng ("automation is already running, run <id> in progress") thay vì
chạy chồng. Release lock khi run kết thúc (thành công, lỗi, hoặc
timeout).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| `running_lock` bị kẹt `true` mãi nếu process crash giữa chừng, không kịp release | Trung bình | Cần TTL/heartbeat hoặc kiểm tra `updated_at` quá cũ để tự giải phóng lock — không để 1 crash khoá automation vĩnh viễn |
| Timeout 2 giờ có thể quá ngắn cho vài automation hợp lệ (vd. chain nhiều action, agent task dài) | Thấp | Cho phép override per-automation (`run_timeout_seconds`), default 2 giờ chỉ là an toàn tối thiểu |
| Retention prune chạy đồng bộ trong dispatch path có thể chậm nếu automation có rất nhiều run cũ | Thấp | Prune bằng 1 câu SQL `DELETE ... LIMIT` hiệu quả, không load hết run vào memory rồi lọc (khác cách TS side hiện làm trong `pruneAutomationRuns` — kiểm tra lại cách nó implement trước khi copy 1:1 sang Go) |

## Không thuộc phạm vi CR này

- Timeout/retention cho automation cũ chạy trên implementation #1/#2
  (Electron/Node) — CR này viết cho backend canonical
  ([CR-AUTO-001](./CR-AUTO-001-consolidate-execution-backend.md)); nếu
  2 bản kia còn sống song song, cần CR tương tự riêng hoặc chấp nhận gap
  đó tồn tại có kiểm soát (được ghi nhận, không âm thầm).

## Liên quan

- `frontend/src/shared/automation-run-retention.ts:3` (`MAX_AUTOMATION_RUNS_PER_AUTOMATION`)
- `backend-go/services/automation-service/internal/adapter/scheduler/ticker.go`
- `backend-go/services/automation-service/internal/adapter/postgres/repository.go` (`ClaimDue`)
- `specs/backend-go/bugs/logic-v1/BUG-AT-02-chay-automation-schedule-partial.md` (nguồn gốc BR-AT timeout/retention/concurrency)
- `desktop/src/main/workflow/StepExecutors.ts:19` (`DEFAULT_TIMEOUT_MS`, timeout per-step khác với timeout per-chain)
- [CR-AUTO-002](./CR-AUTO-002-multi-action-chain-data-model.md) (nơi gắn timeout tổng chain)
