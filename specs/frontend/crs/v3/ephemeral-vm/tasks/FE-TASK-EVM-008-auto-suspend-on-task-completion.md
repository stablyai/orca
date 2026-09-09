# FE-TASK-EVM-008: Auto-suspend VM sau khi task hoàn thành

**Solution:** [FE-SOL-EVM-006](../solutions/FE-SOL-EVM-006-auto-destroy-on-task-completion.md) | **CR:** CR-EVM-010
**Depends on:** [FE-TASK-AUTO-007](../../../../frontend/crs/v4/automation/tasks/FE-TASK-AUTO-007-agent-session-signal-investigation.md) (khảo sát tín hiệu chung — phải xong trước)
**Status:** 🔲 TODO — chờ kết quả khảo sát tín hiệu

---

## Mục tiêu

Chỉ thực thi phần code sau khi
[FE-TASK-AUTO-007](../../../../frontend/crs/v4/automation/tasks/FE-TASK-AUTO-007-agent-session-signal-investigation.md)
xác nhận tín hiệu `AgentDetector` phù hợp làm trigger tự động. Nếu khảo
sát đó kết luận KHÔNG phù hợp, task này BLOCKED vô thời hạn cho tới khi
có tín hiệu khác được đề xuất.

## Files cần sửa (chỉ khi tín hiệu đã được xác nhận)

1. `desktop/src/main/runtime/orca-runtime-pty-exit.ts` (MODIFY, hoặc điểm hook đúng theo kết quả khảo sát)
2. `frontend/src/renderer/src/components/settings/EphemeralVmRuntimesSection.tsx` (MODIFY — checkbox "Keep VM running after task")

## Nội dung (xem FE-SOL-EVM-006 §3, điều chỉnh theo kết quả khảo sát thật)

- Chính sách mặc định: suspend (không destroy).
- Lookup: PTY → workspace → có ephemeral VM runtime không.
- Gọi `suspendRuntimeEphemeralVmWorkspace`, idempotent-safe (xác nhận gọi 2 lần không lỗi trước khi wire).
- Checkbox tắt per-workspace, mặc định off (auto-suspend mặc định bật).

## Test cases cần cover

- Session agent kết thúc, workspace có ephemeral VM, checkbox không tắt → `suspendRuntimeEphemeralVmWorkspace` được gọi đúng 1 lần.
- Checkbox "Keep VM running" bật → không gọi suspend.
- Sự kiện bắn 2 lần liên tiếp (idle→working→idle nhanh) → không gọi suspend 2 lần lỗi (idempotent).
- Workspace không phải ephemeral VM → không có hành vi gì thay đổi.

## Verify

```bash
cd desktop && npx vitest run src/main/runtime/orca-runtime-pty-exit.test.ts
cd ../frontend && npx vitest run src/renderer/src/components/settings/EphemeralVmRuntimesSection.test.tsx
npx tsc --noEmit
```

## gitnexus

`impact({target: "suspendRuntimeEphemeralVmWorkspace", direction: "upstream"})`
trước khi thêm call site mới.
