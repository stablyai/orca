# SOL-AGENT-TASKV1-002: Nối dây Task Execute worker dispatch — `orchestration-service` phải gọi `infra-fleet-service`, và `infra-fleet-service` cần 1 kênh streaming cho `agent.spawn`

**Giải quyết:** [BUG-AGENT-TASKV1-002](../BUG-AGENT-TASKV1-002-task-execute-worker-dispatch-primitives-unwired.md)

## Gap này nằm ở đâu?

**✅ Không nằm ở `agent/`.** Cả 2 đường primitive đều đã đúng và đủ ở
`agent/`, xác nhận lại bằng code thật:

- `agent.spawn`/`agent.sendInput`/`agent.kill` — dispatch tại
  `agent/src/relay/agent-rpc-dispatch-agent-exec.ts:23-31` (spawn, fire-and-
  forget trả `{type:'spawn.accepted'}` ngay), `:47-62` (sendInput), và
  `agent-spawner.ts:648-651` (`kill`, tôn trọng `params.signal` — SIGTERM
  mặc định, SIGKILL nếu yêu cầu).
- Notification `agent.output`/`agent.exited` — JSON-RPC notification thật
  (không có `id`, không lẫn với response — đúng bài học BUG-AG-ORCH-006),
  emit tại `agent-spawner.ts:604` và `:621` qua `sendAgentSpawnNotification`
  (định nghĩa dòng 138).
- Đường tắt `pty.create`+`AttachPty` cũng đã có sẵn, đã production cho
  Terminal UI, emit `pty.data` theo đúng convention notification tương tự
  (`agent/src/relay/pty-agent-bridge.ts:245-248`).

Gap thật nằm ở 2 chỗ, **cả hai đều ở `backend-go`**:

1. `orchestration-service` chưa có `StartCoordinatorRun`/dispatch loop nào
   gọi tới `infra-fleet-service` — đã được track đầy đủ tại
   [`specs/backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md`](../../../../backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md)
   (chưa có solution tại thời điểm audit — `specs/backend-go/bugs/task-v1/solutions/`
   không có `SOL-TASKV1-005`).
2. `infra-fleet-service.Relay` là RPC **unary**
   (`backend-go/proto/orca/infrafleet/v1/infrafleet.proto:47`) — không có
   kênh nào nhận notification `agent.output`/`agent.exited` phát sinh sau
   response `{type:'spawn.accepted'}`. **`BUG-TASKV1-005` không đề cập gap
   này** — đây là phát hiện bổ sung của audit, ghi ở đây vì nó ảnh hưởng trực
   tiếp tới thiết kế `StartCoordinatorRun`'s dispatch logic.

## Phát hiện quan trọng: thiết kế cho Gap 2 đã tồn tại — chỉ chưa áp dụng cho Task Execute

Đọc thêm `specs/backend-go/bugs/logic-v1/` (audit gốc của thư mục này chưa
cross-reference) cho thấy **gap 2 đã có 1 thiết kế cụ thể**, viết cho use
case khác (Agent lifecycle UI — "Khởi động Agent", không phải Task Execute):

[`SOL-AG-01-khoi-dong-agent.md`](../../../../backend-go/bugs/logic-v1/solutions/SOL-AG-01-khoi-dong-agent.md)
(giải quyết
[`BUG-AG-01-khoi-dong-agent-partial.md`](../../../../backend-go/bugs/logic-v1/BUG-AG-01-khoi-dong-agent-partial.md),
**Status: PARTIAL** — thiết kế có, chưa xác nhận triển khai đầy đủ) đặc tả
rõ tại dòng 205-212:

> `SpawnAgent` calls `agent.spawn`. Returns immediately once the agent
> accepts the request (`{ok:true, ptyId}`) — output/exit arrive later as
> `agent.output`/`agent.exited` notifications **over the same `StreamPty`
> subscription used for plain PTYs** (the wire shape is deliberately the
> same notification mechanism).

Nghĩa là: đường tắt **(a)** mà audit gốc đề xuất — "tái dùng
`AttachPty`-kiểu streaming cho `agent.spawn`'s notification, không cần RPC
mới" — **đã được thiết kế ở backend-go**, chỉ chưa track dưới góc nhìn Task
Execute. Đây KHÔNG PHẢI 1 RPC hoàn toàn mới cần xây (như audit gốc lo ngại ở
mục 2), mà là **tái dùng `AttachPty`** (cùng RPC streaming đã tồn tại,
`infrafleet.proto:104`) cho cả `pty.data` VÀ `agent.output`/`agent.exited` —
phía backend chỉ cần route notification theo `ptyId`, không quan tâm nó đến
từ `pty.create` hay `agent.spawn` (agent/ đã emit cùng 1 shape
`{ptyId, data}`/`{ptyId, exitCode}` cho cả hai, xem
`agent-spawner.ts:604,621` so với `pty-agent-bridge.ts:247,252`).

## Giải pháp đề xuất cho backend-go (2 việc, độc lập, nên làm theo thứ tự)

### Việc 1 — `infra-fleet-service`: mở rộng `AttachPty`'s nhận notification để bao phủ `agent.output`/`agent.exited`

Không cần RPC gRPC mới. Cần: usecase nhận notification trên WS session hiện
có (giống cách `spawn_terminal_session.go`/`attach_pty.go` map `pty.data` →
`PtyServerFrame`) áp dụng **thêm 1 nhánh** cho `method === 'agent.output'`
hoặc `'agent.exited'`, map sang cùng `PtyServerFrame` message (đã có field
`id`/`data` tổng quát — xác nhận cần đọc lại
`infra-fleet-service/internal/usecase/attach_pty.go` trước khi implement,
ngoài phạm vi audit này để đọc kỹ shape `PtyServerFrame`). Đây là điểm nối
với `SOL-AG-01`'s thiết kế — nên implement **1 lần, dùng chung** cho cả
Agent-lifecycle UI (`BUG-AG-01`) và Task Execute (bug này), tránh 2 team xây
2 đường khác nhau cho cùng 1 notification shape.

### Việc 2 — `orchestration-service`: implement `StartCoordinatorRun`/dispatch loop gọi `infra-fleet-service`

Nằm ngoài phạm vi `agent/` hoàn toàn — đã track ở `BUG-TASKV1-005`. Khi
implement, dispatch logic nên gọi `agent.spawn` qua `Relay` (unary, chỉ cần
ack `{type:'spawn.accepted'}`) rồi **subscribe cùng session** qua kênh Việc 1
ở trên để nhận `agent.output`/`agent.exited` — không mở kết nối thứ 2 (đúng
ràng buộc mà cả `SOL-AG-PW-001` lẫn `SOL-AG-01` đều nêu).

## Không cần thay đổi gì ở `agent/`

Xác nhận lại: cả `agent.spawn`'s notification shape
(`{ptyId, data: base64}`/`{ptyId, exitCode}`) và `pty.data`'s shape
(`{id, data}`) đã đủ để backend-go route theo `ptyId`/`id` — không cần agent/
đổi field, đổi tên method, hay thêm RPC nào mới để hỗ trợ Task Execute.

## Rủi ro liên đới — không phải phạm vi bug này, chỉ ghi nhận

- BUG-AG-ORCH-009 (resume session)/BUG-AG-ORCH-010 (switch account) vẫn
  ⏸ DEFERRED — nếu Task Execute cần restart-resilient coordinator hoặc
  auto-switch account khi rate-limit, cần audit riêng khi tới lúc.
- `pty.listProcesses` (Part A) không liệt kê PTY của `agent.spawn`'s
  `PTY_REGISTRY` (2 registry tách biệt) — nếu `orchestration-service` cần
  "list các worker đang chạy" như 1 cách polling dự phòng (không dùng
  notification), cần 1 RPC liệt kê riêng — không có trong scope bug này.

## Kết luận / Status

**✅ Không cần action ở `agent/`.** Việc cần làm là 2 thay đổi độc lập ở
backend-go (`infra-fleet-service` mở rộng nhận notification qua `AttachPty`
đã có; `orchestration-service` implement dispatch loop) — mục Việc 1 nên
làm **chung** với `SOL-AG-01`'s thiết kế thay vì xây riêng.

## Tham khảo

- [`specs/backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md`](../../../../backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md)
- [`specs/backend-go/bugs/logic-v1/BUG-AG-01-khoi-dong-agent-partial.md`](../../../../backend-go/bugs/logic-v1/BUG-AG-01-khoi-dong-agent-partial.md) — Status PARTIAL
- [`specs/backend-go/bugs/logic-v1/solutions/SOL-AG-01-khoi-dong-agent.md`](../../../../backend-go/bugs/logic-v1/solutions/SOL-AG-01-khoi-dong-agent.md) — dòng 205-212, thiết kế tái dùng `StreamPty`/`AttachPty` cho `agent.output`/`agent.exited`
- [`specs/agent/crs/v3/project-workspace/solutions/SOL-AG-PW-001-execution-progress-reporting-design.md`](../../../crs/v3/project-workspace/solutions/SOL-AG-PW-001-execution-progress-reporting-design.md)

## Trích dẫn file:line (đọc trực tiếp, 2026-09-08)

- `agent/src/relay/agent-rpc-dispatch-agent-exec.ts:23-31,47-62` — dispatch `agent.spawn`(fire-and-forget)/`agent.sendInput`.
- `agent/src/relay/agent-spawner.ts:138-145,604,621,648-651` — `sendAgentSpawnNotification`, emit `agent.output`/`agent.exited`, signal handling (`ORCH-002`).
- `agent/src/relay/pty-agent-bridge.ts:245-253` — `pty.data`/`pty.exit` notification, cùng convention với `agent.output`/`agent.exited`.
- `backend-go/proto/orca/infrafleet/v1/infrafleet.proto:47,104` — `Relay` (unary) vs `AttachPty` (streaming).
- `specs/backend-go/bugs/logic-v1/solutions/SOL-AG-01-khoi-dong-agent.md:205-212` — thiết kế tái dùng `StreamPty` cho `agent.spawn`'s notification.
