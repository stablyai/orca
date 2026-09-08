# BACKLOG-017: 6 RPC mới của `orchestration-service` (coordinator lifecycle) chưa lộ ra `wscompat` — Task Execute dashboard UI vẫn chỉ dùng được `dispatchShow`

**Origin:** Phát hiện trong lúc thực thi `specs/backend-go/bugs/task-v1` (`TASK-TASKV1-005-01..10`, 2026-09-08) và `TASK-FE-TASKV1-10`
**Priority:** Medium — orchestration coordinator giờ đã tự động thật (tick loop, 6 RPC mới), nhưng frontend không có cách nào hiển thị chi tiết
**Blocked on:** **Cập nhật 2026-09-08:** không đúng — cả 6 RPC đều **chưa tồn tại** ở bất kỳ layer nào (proto/usecase/gRPC handler), không phải chỉ "chưa wire vào wscompat" như tiêu đề file này giả định. Xem "Update 2026-09-08 (session 2)" bên dưới.

---

> **Update 2026-09-08 (session 2):** Điều tra lại (đọc code thật, không
> đọc spec) để wire `orchestration.getCoordinatorRun` /
> `orchestration.listPendingDecisionGates` vào `channels_orchestration.go`
> theo hướng dẫn của file này. **Không thể làm được** — cả 6 RPC
> (`StartCoordinatorRun`, `GetCoordinatorRun`, `CompleteCoordinatorRun`,
> `FailCoordinatorRun`, `RecordHeartbeat`, `ListPendingDecisionGates`)
> không tồn tại ở bất kỳ đâu trong `backend-go`, xác nhận bằng cách đọc
> trực tiếp:
>
> - `proto/orca/orchestration/v1/orchestration.proto` chỉ có 7 RPC cũ
>   (`CreateDispatchContext`, `CreateGate`, `ResolveGate`,
>   `UpdateTaskStatusAndPromote`, `GetDispatchContextForTask`,
>   `ListActiveDispatchContextsForUser`, `FailDispatch`) — không RPC nào
>   trong 6 RPC trên có trong proto, generated Go
>   (`orchestration.pb.go`/`orchestration_grpc.pb.go`), hay
>   `internal/adapter/grpc/server.go`.
> - `internal/usecase/ports.go` không có `CoordinatorRunRepository` port,
>   không có `GateRepository.ListPending`, không có
>   `DispatchContextRepository.RecordHeartbeat`.
> - `internal/domain/orchestration.go` chỉ có `NewCoordinatorRun` — không
>   có state-machine/transition method nào khác cho `CoordinatorRun`.
> - `orchestration-service/README.md`'s "Known gaps" section (vẫn đúng,
>   chưa ai sửa) đã ghi rõ: 6 RPC này "không có trong generated proto, nên
>   không RPC/usecase nào tồn tại cho chúng."
>
> Nói cách khác: **BACKLOG-009 và BACKLOG-017 cùng chung một root cause.**
> `specs/backend-go/bugs/task-v1/tasks/TASK-TASKV1-005-01` đến `-10` là
> một spec đầy đủ, đã thiết kế xong (migration, proto, domain, ports,
> Postgres repo, 2 adapter cross-service mới, gRPC handlers, tick loop) —
> nhưng **chưa ai implement**. Đây không còn là việc "wire RPC có sẵn vào
> wscompat" nữa mà là phải build cả một backend feature nhiều tầng trước
> — vượt quá phạm vi "wiring job" mà cả file này (và task hiện tại) giả
> định. Không viết code speculative trong phiên này theo đúng yêu cầu
> "đừng ép một fix chưa đủ chín — dừng lại, ghi rõ những gì tìm thấy."
>
> Việc thiết kế UI (`CoordinatorRunPanel`) cũng bị chặn theo — không có gì
> để component đó gọi cho đến khi `TASK-TASKV1-005-09` (gRPC handlers) tồn
> tại thật.
>
> **Khuyến nghị:** thực thi `TASK-TASKV1-005-01..10` như một đợt
> implementation riêng, có chủ đích (đã được spec đầy đủ, có thứ tự phụ
> thuộc và bước verify cho từng task) — không nhét vào phạm vi của
> BACKLOG-009/017. Sau khi `-09` xong, `GetCoordinatorRun`/
> `ListPendingDecisionGates` mới có RPC thật để đăng ký vào
> `channels_orchestration.go` theo đúng hướng dẫn ban đầu của file này.

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
