# backend-go Solutions — Automations (v4)

**CRs:** [docs/crs/v4/automations/](../../../../../../docs/crs/v4/automations/README.md)
**Frontend counterpart:** [specs/frontend/crs/v4/automation/solutions/](../../../../frontend/crs/v4/automation/solutions/README.md)
**Agent counterpart:** [specs/agent/crs/v4/automation/solutions/](../../../../agent/crs/v4/automation/solutions/README.md)
**TDD tham chiếu:** [`automation-service.md`](../../../../tdd/services/automation-service.md), [`workflow-service.md`](../../../../tdd/services/workflow-service.md) §step executors

## Đánh giá trạng thái hiện tại (bắt buộc trước khi thiết kế — theo yêu cầu)

`backend-go/services/automation-service` **đã là 1 service thật, không
phải khung sườn**: 7 RPC implement thật (`server.go`), Postgres schema
thật (`migrations/0001_init.up.sql`, `0002_scheduler_columns.up.sql`),
scheduler thật (`internal/adapter/scheduler/ticker.go`, `ClaimDue` qua
`SELECT ... FOR UPDATE SKIP LOCKED`), và **renderer đã gọi nó thật** cho
mọi automation được tạo trong lúc pair với 1 runtime environment (xem
[CR-AUTO-001](../../../../../../docs/crs/v4/automations/CR-AUTO-001-consolidate-execution-backend.md)'s
"Cập nhật 2026-09-09" — sửa lại kết luận sai của audit gốc). Ngoài ra,
`workflow-service` (service riêng, automation delegate execution qua nó)
**đã có sẵn 4 step executor thật, chạy tới tận agent**: `agent`, `shell`,
`notification`, `webhook`, `condition` (`internal/domain/step.go:18-19`,
`internal/adapter/infrafleetclient/{shell,notification,agent}_step_executor.go`).

**Kết luận: phần lớn hạ tầng đã có sẵn.** 8 CR-AUTO không cần backend-go
xây từ đầu — cần: (1) thêm `actions[]` (action chain, hiện chưa có model
nhiều bước), (2) map 4 action loại còn thiếu tương ứng đúng step type có
sẵn hoặc thêm 1 step type mới (`commit_push` — không step type nào khớp
sẵn), (3) đóng vài gap vận hành (retention/timeout/auth/REST parity) đã
tự ghi nhận trong chính `README.md`/bug docs của service.

## Solutions

| Solution | CR | Service | Status |
|---|---|---|---|
| [BE-AUTO-SOL-001](./BE-AUTO-SOL-001-confirm-routing-close-gaps.md) | CR-AUTO-001 | `automation-service`, `api-gateway` | 🔲 Designed — chưa implement |
| [BE-AUTO-SOL-002](./BE-AUTO-SOL-002-multi-action-chain-data-model.md) | CR-AUTO-002 | `automation-service` | 🔲 Designed — chưa implement |
| [BE-AUTO-SOL-003](./BE-AUTO-SOL-003-action-executors-commit-pr.md) | CR-AUTO-003 | `automation-service`, `workflow-service` | 🔲 Designed — chưa implement |
| [BE-AUTO-SOL-004](./BE-AUTO-SOL-004-action-executors-script-notification.md) | CR-AUTO-004 | `automation-service`, `workflow-service` | 🔲 Designed — chưa implement |
| [BE-AUTO-SOL-005](./BE-AUTO-SOL-005-real-event-triggers.md) | CR-AUTO-005 | `automation-service` | 🔲 Designed — chưa implement |
| [BE-AUTO-SOL-006](./BE-AUTO-SOL-006-retention-scheduler-hardening.md) | CR-AUTO-007 | `automation-service` | 🔲 Designed — chưa implement |
| [BE-AUTO-SOL-007](./BE-AUTO-SOL-007-rest-parity-webhook-auth.md) | CR-AUTO-008 | `automation-service`, `api-gateway` | 🔲 Designed — chưa implement |

CR-AUTO-006 (`WorktreeCleanupService.ts`) không có solution ở đây — thuần
Electron main process, xem
[FE-AUTO-SOL-006](../../../../frontend/crs/v4/automation/solutions/FE-AUTO-SOL-006-worktree-cleanup-service.md).

## Thứ tự implement

```
BE-AUTO-SOL-001 → làm trước — hầu hết là XÁC NHẬN, không phải code lớn;
                  chốt xong mới có nền cho 002
BE-AUTO-SOL-002 → phụ thuộc CỨNG vào 001 (đã chốt: backend-go là canonical
                  cho automation pairing-path) — thêm actions[] vào
                  Automation message + usecase loop
BE-AUTO-SOL-003,
BE-AUTO-SOL-004 → phụ thuộc CỨNG vào 002 (cần actions[] tồn tại) — làm
                  song song được, 004 nhẹ hơn nhiều (chỉ mapping, không
                  executor mới) nên có thể xong trước 003
BE-AUTO-SOL-005 → phụ thuộc MỀM vào 001 (cần biết caller nào hợp lệ) —
                  độc lập với 002/003/004
BE-AUTO-SOL-006,
BE-AUTO-SOL-007 → độc lập hoàn toàn với nhóm trên — làm song song bất cứ
                  lúc nào
```

## Nguyên tắc bảo mật xuyên suốt (kế thừa từ nhóm CR-STORAGE/CR-EVM)

`tenantID`/`userID` cho mọi usecase mới ở đây **luôn lấy từ
`tenant.RequireTenantID(ctx)`/`Identity` đã xác thực** — không bao giờ từ
`args`/request field do client gửi, đúng quy tắc đã kiểm chứng ở
`BE-SOL-STORAGE-001`/`002`, `BE-SOL-EVM-*`, và `tenant-service.md` §9.
`automation-service`'s usecase hiện có (`create_automation.go`,
`run_now.go`, ...) đã tuân thủ đúng quy tắc này — mọi solution dưới đây
tiếp tục đúng pattern, không nới lỏng.
