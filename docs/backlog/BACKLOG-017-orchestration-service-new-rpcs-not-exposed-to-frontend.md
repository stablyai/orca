# BACKLOG-017: 6 RPC mới của `orchestration-service` (coordinator lifecycle) chưa lộ ra `wscompat` — Task Execute dashboard UI vẫn chỉ dùng được `dispatchShow`

**Origin:** Phát hiện trong lúc thực thi `specs/backend-go/bugs/task-v1` (`TASK-TASKV1-005-01..10`, 2026-09-08) và `TASK-FE-TASKV1-10`
**Priority:** Medium — orchestration coordinator giờ đã tự động thật (tick loop, 6 RPC mới), nhưng frontend không có cách nào hiển thị chi tiết
**Blocked on:** Không có blocker — cần thiết kế + wire RPC mới vào `wscompat`

---

## Hiện trạng

Đợt thực thi `TASK-TASKV1-005-*` đã làm cho `orchestration-service`'s coordinator hoạt động **tự động thật** (tick loop dispatch, 6 RPC mới: `StartCoordinatorRun`, `GetCoordinatorRun`, `CompleteCoordinatorRun`, `FailCoordinatorRun`, `RecordHeartbeat`, `ListPendingDecisionGates`). Nhưng **không RPC nào trong 6 cái này được đăng ký ở `channels_orchestration.go`** — `wscompat` vẫn chỉ có `orchestration.dispatchShow` (dùng cho terminal-handle-link) + `agentSession.listActive`.

`TaskDispatchStatusPanel` (đã build ở `TASK-FE-TASKV1-10`) hiện chỉ hiển thị được thông tin tối thiểu qua `dispatchShow` — không có dashboard đầy đủ (xem coordinator run đang chạy, decision gate đang chờ resolve, heartbeat...).

## Việc cần làm khi triển khai

1. Đăng ký `orchestration.getCoordinatorRun`, `orchestration.listPendingDecisionGates` (đọc, ưu tiên trước — phục vụ dashboard) vào `channels_orchestration.go`.
2. Thiết kế UI mới (`CoordinatorRunPanel`?) hiển thị đầy đủ — hiện `TaskDispatchStatusPanel` chỉ là bản tối thiểu, không phải sản phẩm cuối.
3. Cân nhắc: `CompleteCoordinatorRun`/`FailCoordinatorRun`/`RecordHeartbeat` là RPC nội bộ (agent/worker gọi), không cần lộ ra frontend — chỉ `GetCoordinatorRun`/`ListPendingDecisionGates`/`StartCoordinatorRun` (nếu muốn cho user tự trigger) mới cần.

## Tham khảo
- `specs/backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md`
- `specs/backend-go/bugs/task-v1/tasks/TASK-TASKV1-005-09-grpc-handlers-and-main-wiring.md`
- `specs/frontend/bugs/task-v1/solutions/SOL-FE-TASKV1-006-task-execute-orchestration-ui-khong-ton-tai.md`, `tasks/TASK-FE-TASKV1-10-task-dispatch-status-panel.md`
