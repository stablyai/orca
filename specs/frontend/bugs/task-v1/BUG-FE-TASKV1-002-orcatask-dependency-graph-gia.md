# BUG-FE-TASKV1-002 — `TaskDAGView` vẽ dependency graph giả (luôn rỗng), không có UI thêm/xoá edge

**Mức độ:** 🟠 High
**Status:** 🔴 Open
**Module:** `frontend/src/renderer/src/components/task/TaskDAGView.tsx`, `TaskDetail.tsx`
**Phát hiện:** 2026-09-08 (audit frontend vs 3 hệ Task: OrcaTask/Task Execute/Workflow Orchestration)

---

## Mô tả

`TaskDAGView.tsx`'s `buildDAGLayout()` đọc `(task as any).dependsOn ?? []` để
dựng wave/edge cho `ReactFlow` (dòng 30-33, 106). Comment tự thú ngay tại chỗ
đọc field:

> `// NOTE: OrcaTask has no embedded 'dependsOn' — edges live in a separate
> table (task.getDependencies per task). Always [] until that's wired in
> (out of scope here).`

Vì `OrcaTask` (kiểu dữ liệu thật, `shared/task-types.ts`) không có field
`dependsOn`, ép kiểu `as any` luôn trả `undefined ?? []` → `dependsOnMap` luôn
rỗng cho MỌI task → `waveMap` luôn gán wave 0 cho tất cả → `edges` luôn `[]`.
Kết quả: `TaskDAGView` render đúng layout (đẹp, có màu theo status, có
`ReactFlow`/`MiniMap`/`Controls` thật) nhưng **không bao giờ vẽ được 1 cạnh
dependency nào**, bất kể task có phụ thuộc thật ở backend hay không — đây là
"đồ thị giả" hiển thị các node cô lập cùng 1 cột.

Trong khi đó, `TaskDetail.tsx` (dòng 42-58) đã gọi đúng RPC
`task.getDependencies` (trả về `{ task, edgeType }[]`, split theo
`edgeType === 'depends_on' | 'blocks'`) để hiển thị dependency dạng text
("← Blocked by" / "→ Blocks") ở tab Details — nghĩa là backend + RPC đọc đã
sẵn sàng và đã được 1 component khác dùng đúng cách, chỉ riêng
`TaskDAGView.tsx` quên gọi nó.

Ngoài ra, không có UI nào cho phép **thêm** hoặc **xoá** 1 dependency edge —
`task.getDependencies` (đọc) là RPC method **duy nhất** liên quan tới
dependency được frontend gọi; RPC ghi tương ứng ở backend-go là `AddEdge`
(`task.proto:16`) nhưng không component nào trong `frontend/src` gọi nó (0
kết quả grep `AddEdge`/`addDependency`/`removeDependency` trong toàn bộ
`renderer/src`).

## Hậu quả

- Tab DAG (`view-dag` trong `TaskGraph.tsx`) hiển thị sai lệch hoàn toàn so
  với thực tế — user thấy tất cả task nằm 1 hàng độc lập dù có phụ thuộc
  thật, dẫn tới nhầm lẫn nghiêm trọng khi dùng DAG để lập kế hoạch thứ tự
  thực thi.
- Không thể quản lý dependency qua UI trực quan (kéo-nối node) — phải biết
  RPC `AddEdge` và gọi tay (Postman/CLI), hoàn toàn không khả dụng cho end
  user.
- Tính năng "topological wave" (nhóm task theo wave phụ thuộc, vốn là điểm
  bán chính của DAG view) hiện vô nghĩa vì luôn ra wave 0 cho tất cả.

## Bằng chứng

```
frontend/src/renderer/src/components/task/TaskDAGView.tsx:28-33  → comment tự thú "Always [] until that's wired in (out of scope here)"
frontend/src/renderer/src/components/task/TaskDAGView.tsx:106    → `const deps = (task as any).dependsOn ?? []` lặp lại lần 2 khi build edges — luôn rỗng
frontend/src/renderer/src/components/task/TaskDetail.tsx:42-58   → cách gọi ĐÚNG: `callRuntimeRpc(target, 'task.getDependencies', { taskId })`, split theo edgeType
backend-go/proto/orca/task/v1/task.proto:16                       → `rpc AddEdge(AddEdgeRequest) returns (AddEdgeResponse);` tồn tại nhưng 0 lời gọi từ frontend
```

## Đề xuất fix

1. Sửa `TaskDAGView.tsx` để nhận `dependsOn` qua props được fetch trước (ví dụ `TaskGraph.tsx` gọi `task.getDependencies` cho từng task hiển thị, hoặc tốt hơn — đề xuất backend-go bổ sung batch endpoint trả toàn bộ edge theo `projectId` 1 lần thay vì N+1 call theo từng task) thay vì đọc field không tồn tại trên `OrcaTask`.
2. Thêm UI thêm/xoá edge: kéo nối 2 node trên `ReactFlow` (đã có `nodesConnectable={false}` — cần bật lại có kiểm soát) → gọi `task.addEdge`/tương đương `AddEdge`; xác nhận trước với backend cypher/tên RPC chính xác đang lộ ra ở tầng RPC (không phải chỉ proto).
3. Thêm indicator loading/error khi fetch dependency thất bại — hiện tại lỗi bị nuốt hoàn toàn (`.catch(() => {})` ở `TaskDetail.tsx`).

## Tham khảo

- Backend liên quan: [BUG-TASKV1-001](../../../backend-go/bugs/task-v1/BUG-TASKV1-001-orcatask-data-model-and-state-machine-gap.md) (AddEdge RPC method wiring, nếu chưa lộ ra ở RPC layer/wscompat)
- Liên quan: BUG-FE-TASKV1-001 (cùng cụm gap — cây/DAG task đều build phía client vì thiếu RPC phù hợp)
