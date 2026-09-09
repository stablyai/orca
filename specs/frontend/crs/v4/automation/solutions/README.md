# frontend Solutions — Automations (v4)

**CRs:** [docs/crs/v4/automations/](../../../../../../docs/crs/v4/automations/README.md)
**backend-go counterpart:** [specs/backend-go/crs/v4/automations/solutions/](../../../../backend-go/crs/v4/automations/solutions/README.md)
**Agent counterpart:** [specs/agent/crs/v4/automation/solutions/](../../../../agent/crs/v4/automation/solutions/README.md)
**TDD tham chiếu:** [TDD-FE-03](../../../../tdd/v5/03-runtime-client-layer.md) §2 (Runtime RPC Client)

## Đánh giá trạng thái hiện tại

`frontend/src/renderer/src/components/automations/` là **lớp UI trưởng
thành nhất** trong toàn bộ 3 tầng cho F14 (`AutomationsPage.tsx` 2991
dòng, 30+ file con, đã có routing 2-trục qua `automation-host-client.ts`
— xem
[CR-AUTO-001](../../../../../../docs/crs/v4/automations/CR-AUTO-001-consolidate-execution-backend.md)'s
"Cập nhật 2026-09-09"). Phần lớn việc ở tầng này cho nhóm CR-AUTO là
**mở rộng UI đã có** (thêm action-type vào form, thêm trigger-type vào
picker) — không xây lại từ đầu. Ngoại lệ: 2 file **Electron main
process** thật sự chết (`AutomationEventBridge.ts`,
`WorktreeCleanupService.ts`, cả 2 ở `desktop/src/main/automations/`) cần
quyết định dứt điểm.

**Lưu ý phạm vi**: theo yêu cầu, mọi solution "frontend" cho nhóm CR-AUTO
này bao gồm cả phần Electron main process (`desktop/src/main/`) — dù
`desktop/` có TDD riêng ở `specs/backend/tdd/` (tên "backend" ở đây chỉ
là tên thư mục lịch sử cho code Node/Electron, khác `backend-go`), các
solution dưới đây gộp chung vào `specs/frontend/` theo đúng cấu trúc
được yêu cầu, có ghi chú rõ layer (renderer vs Electron main) trong từng
file.

## Solutions

| Solution | CR | Layer | Status |
|---|---|---|---|
| [FE-AUTO-SOL-001](./FE-AUTO-SOL-001-confirm-routing.md) | CR-AUTO-001 | renderer | 🔲 Designed — chưa implement |
| [FE-AUTO-SOL-002](./FE-AUTO-SOL-002-actions-type-plumbing.md) | CR-AUTO-002 | renderer (shared types) | 🔲 Designed — chưa implement |
| [FE-AUTO-SOL-003](./FE-AUTO-SOL-003-action-config-form-commit-pr.md) | CR-AUTO-003 | renderer | 🔲 Designed — chưa implement |
| [FE-AUTO-SOL-004](./FE-AUTO-SOL-004-action-config-form-script-notification.md) | CR-AUTO-004 | renderer | 🔲 Designed — chưa implement |
| [FE-AUTO-SOL-005](./FE-AUTO-SOL-005-real-event-triggers.md) | CR-AUTO-005 | renderer + Electron main | 🔲 Designed — chưa implement |
| [FE-AUTO-SOL-006](./FE-AUTO-SOL-006-worktree-cleanup-service.md) | CR-AUTO-006 | Electron main | 🔲 Designed — chưa implement |

CR-AUTO-007, CR-AUTO-008 không có solution ở đây — thuần backend-go, xem
[BE-AUTO-SOL-006](../../../../backend-go/crs/v4/automations/solutions/BE-AUTO-SOL-006-retention-scheduler-hardening.md)/[007](../../../../backend-go/crs/v4/automations/solutions/BE-AUTO-SOL-007-rest-parity-webhook-auth.md).

## Thứ tự implement

```
FE-AUTO-SOL-001 → làm trước, chủ yếu xác nhận — không chặn gì nhưng nên
                  chốt sớm để các solution sau không lặp lại giả định sai
FE-AUTO-SOL-002 → phụ thuộc CỨNG BE-AUTO-SOL-002 (backend-go) tồn tại để
                  có field `actions` đọc/ghi qua RPC
FE-AUTO-SOL-003,
FE-AUTO-SOL-004 → phụ thuộc CỨNG FE-AUTO-SOL-002 (chung component
                  AutomationActionConfigForm) — làm song song được
FE-AUTO-SOL-005 → phụ thuộc MỀM BE-AUTO-SOL-005 (cần biết endpoint nào
                  gọi khi agent xong việc) — độc lập với 002/003/004
FE-AUTO-SOL-006 → độc lập hoàn toàn, làm bất cứ lúc nào
```
