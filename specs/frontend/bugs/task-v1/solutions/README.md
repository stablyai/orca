# Solutions — Frontend vs 3 hệ Task (task-v1)

Mục lục giải pháp cho 8 bug ở [`../`](../README.md). Mỗi bug có đúng 1 file
solution tương ứng.

**Trạng thái tất cả:** 📋 Proposed — chưa triển khai.

---

## Bối cảnh: phụ thuộc 1 solution song song

4 bug dưới đây (005, 007, 008, và 1 phần của 004) trỏ tới
[`FE-SOL-001-unified-task-execution-ui.md`](../../../crs/v3/flow-task/solutions/FE-SOL-001-unified-task-execution-ui.md),
đang được viết bởi 1 agent khác (implement `CR-FLOW-TASK-005`).

**Cập nhật (2026-09-08):** `FE-SOL-001` được viết song song bởi 1 agent
khác và đã publish xong sau bộ solution này — đã đối chiếu lại: nội dung
khớp tóm tắt phạm vi ở dưới (ExecutionEngineBadge, AttachWorkflowTemplate,
`useTaskActivity` polling-fallback, fix `useWorkflow.ts`, field `prompt`
optimistic). Các pointer loại A dưới đây coi như đã xác nhận, không còn là
"dự kiến".

## Mục lục

| ID | Bug | Loại | Solution | Phụ thuộc backend chưa sẵn sàng? |
|----|-----|------|----------|-----------------------------------|
| 001 | [BUG-FE-TASKV1-001](../BUG-FE-TASKV1-001-orcatask-crud-va-tree-navigation.md) | B — Full design | [SOL-FE-TASKV1-001](./SOL-FE-TASKV1-001-orcatask-crud-va-tree-navigation.md) | Có (progress cascade thật, tree RPC) — phần "New Task" thì KHÔNG (RPC đã sẵn sàng) |
| 002 | [BUG-FE-TASKV1-002](../BUG-FE-TASKV1-002-orcatask-dependency-graph-gia.md) | B — Full design | [SOL-FE-TASKV1-002](./SOL-FE-TASKV1-002-orcatask-dependency-graph-gia.md) | Một phần — hiển thị đúng DAG thì KHÔNG phụ thuộc; thêm edge cần wire `AddEdge` vào wscompat; xoá edge cần RPC mới hoàn toàn |
| 003 | [BUG-FE-TASKV1-003](../BUG-FE-TASKV1-003-access-control-va-share-link-khong-dung.md) | B — Full design (thu hẹp) | [SOL-FE-TASKV1-003](./SOL-FE-TASKV1-003-access-control-va-share-link-khong-dung.md) | Có — `Grant`/`ResolvePermission` chưa wire wscompat; team resolver là stub; share-link chưa thiết kế |
| 004 | [BUG-FE-TASKV1-004](../BUG-FE-TASKV1-004-run-agent-ux-gaps.md) | Hỗn hợp A (mục 1-2) + B (batch + comment) | [SOL-FE-TASKV1-004](./SOL-FE-TASKV1-004-run-agent-ux-gaps.md) | Có — field `prompt` chưa có ở bất kỳ backend nào; Comment RPC không tồn tại ở backend-go |
| 005 | [BUG-FE-TASKV1-005](../BUG-FE-TASKV1-005-missing-realtime-event-subscriptions.md) | A — Pointer | [SOL-FE-TASKV1-005](./SOL-FE-TASKV1-005-missing-realtime-event-subscriptions.md) | Có — `CR-FLOW-TASK-003` event catalog chưa có bằng chứng triển khai; `subscribeRuntimeEvent` chưa tồn tại ở FE |
| 006 | [BUG-FE-TASKV1-006](../BUG-FE-TASKV1-006-task-execute-orchestration-ui-khong-ton-tai.md) | B — Full design tối thiểu | [SOL-FE-TASKV1-006](./SOL-FE-TASKV1-006-task-execute-orchestration-ui-khong-ton-tai.md) | Có — dashboard đầy đủ cần 5-6 RPC `orchestration.*` chưa tồn tại |
| 007 | [BUG-FE-TASKV1-007](../BUG-FE-TASKV1-007-workflow-builder-rpc-shape-mismatch.md) | A — Pointer | [SOL-FE-TASKV1-007](./SOL-FE-TASKV1-007-workflow-builder-rpc-shape-mismatch.md) | Không cho fix chính, nhưng có đánh đổi cần lưu ý (xem file) |
| 008 | [BUG-FE-TASKV1-008](../BUG-FE-TASKV1-008-dual-backend-rpc-contract-drift.md) | A — Pointer (root cause hệ thống chưa đóng) | [SOL-FE-TASKV1-008](./SOL-FE-TASKV1-008-dual-backend-rpc-contract-drift.md) | Có — quy tắc review/codegen dùng chung là việc process, không phải 1 PR code |

## Phát hiện xuyên suốt khi viết bộ solution này (đáng chú ý)

Khi đọc lại RPC surface thật (`backend-go/services/api-gateway/internal/adapter/wscompat/`)
để thiết kế 001/002/003/006, phát hiện thêm 1 tầng gap **không có trong bug
report gốc**: nhiều RPC brief giả định "chỉ frontend chưa gọi" thực ra
**chưa được wire ở tầng wscompat**, dù đã tồn tại ở gRPC/proto:

| RPC | gRPC/proto | wscompat channel | Ghi nhận ở |
|---|---|---|---|
| `task.create`, `task.get` | ✅ | ✅ (`channels.go`) | — |
| `task.execute/list/update/delete/getDependencies/aiDecompose/aiApply` | ✅ | ✅ (`channels_automation_task.go`) | — |
| `AddEdge` | ✅ | ❌ | SOL-FE-TASKV1-002 |
| `Grant`, `ResolvePermission` | ✅ | ❌ | SOL-FE-TASKV1-003 |
| `RemoveEdge` | ❌ (chưa thiết kế ở proto) | ❌ | SOL-FE-TASKV1-002 |
| `orchestration.dispatchShow` (= `GetDispatchContextForTask`) | ✅ | ✅ (duy nhất trong `orchestration.*`) | — |
| `ListActiveDispatchContextsForUser` | ✅ | ❌ | SOL-FE-TASKV1-006 |
| `StartCoordinatorRun`, `RecordHeartbeat`, `ListPendingDecisionGates` | ❌ (chưa thiết kế ở proto) | ❌ | SOL-FE-TASKV1-006 |
| `AddComment`/`ListComments` (task) | ❌ (chỉ có ở Node, không có ở backend-go) | ❌ | SOL-FE-TASKV1-004 |

Ý nghĩa thực tế: với `backend-go` (target `deploy/dev`), phần lớn thao tác
"ghi" ngoài CRUD cơ bản (`create/update/delete/execute`) **chưa dùng được
qua UI dù có thiết kế UI hoàn chỉnh** — cần 1 đợt wire wscompat trước, tương
tự đợt `TASK-217/219/222/223/224/225` đã làm cho `task.*` cơ bản. Mỗi
solution B ở trên đều ghi rõ phần nào bị chặn bởi gap này.

## Tham khảo chung

- [`../README.md`](../README.md) — danh sách 8 bug gốc
- [`specs/backend-go/bugs/task-v1/README.md`](../../../../backend-go/bugs/task-v1/README.md) — bộ bug backend-go tương ứng
- `specs/frontend/tdd/v5/15-task-graph-ui.md` — kiến trúc UI Task Graph (component/pattern hiện tại)
- `docs/crs/v3/flow-task/` — toàn bộ series CR (001-005)
