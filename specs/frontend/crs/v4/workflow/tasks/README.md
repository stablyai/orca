# Tasks — CR-WF-006/CR-WF-007 (frontend workflow v4)

Task thực thi cho [FE-SOL-001](../solutions/FE-SOL-001-frontend-builder-library-pause-resume.md)
(CR-WF-006, task 001-004) và [FE-SOL-002](../solutions/FE-SOL-002-execution-live-streaming.md)
(CR-WF-007, task 005).

| Task ID | Mô tả | Phụ thuộc | Status |
|---------|-------|-----------|--------|
| [FE-TASK-001](./FE-TASK-001-mount-workflow-builder.md) | Mount `WorkflowBuilder` vào `WorkspaceLayout` (chưa mount ở đâu hôm nay) + vá `useWorkflow.ts`'s `runWorkflow()` thiếu gửi `projectId` | Không có | ✅ DONE — 2026-09-09 |
| [FE-TASK-002](./FE-TASK-002-workflow-template-library.md) | `WorkflowLibrary` — Template Library mới, dùng `workflow.template.list` thật (search/sort/share chờ backend) | FE-TASK-001 (dùng chung `workflowView` state); `SearchTemplates`/sharing RPC chờ BE-SOL-005 cho phần search/share | ✅ DONE — 2026-09-09 |
| [FE-TASK-003](./FE-TASK-003-pause-resume-execution-status-type.md) | Thêm `'paused'` vào `WorkflowExecutionStatus` (đúng file `shared/workflow-types.ts`, không phải file trùng tên ở `renderer/src/types/`) + nút Pause/Resume, vá polling-kẹt sau resume | Không có | ✅ DONE — 2026-09-09 |
| [FE-TASK-004](./FE-TASK-004-step-type-vocabulary-fix.md) | `WorkflowStepType` — rename `notify`→`notification` (an toàn); `approval` GIỮ LẠI chờ xác nhận sản phẩm trước khi xoá | Không có kỹ thuật; phần xoá `approval` chờ quyết định sản phẩm | ✅ DONE — 2026-09-09 (rename an toàn; xoá `approval` vẫn chờ sản phẩm) |
| [FE-TASK-005](./FE-TASK-005-execution-live-streaming-subscription.md) | Consume live execution events qua subscription, polling giữ làm fallback | **🔴 BLOCKED** — chờ `CR-FLOW-TASK-003` rồi `BE-SOL-006`, cả 2 đều 📋 Proposed | 🔴 BLOCKED (bỏ qua đợt này) |
| [FE-TASK-006](./FE-TASK-006-consolidate-duplicate-workflow-types.md) | **Không thuộc FE-SOL-001/002** — dọn dẹp 2 file `workflow-types.ts` trùng lặp (`shared/` thật vs `renderer/src/types/` chết), phát hiện khi làm FE-TASK-003 | Không có — độc lập hoàn toàn | ✅ DONE — 2026-09-09 |

**🔴 P0: FE-TASK-002** (Template Library) — gap chính ma trận hoàn thành CR-WF-006 nêu. Đã hoàn
thành phần Browse/Use qua `workflow.template.list` thật; search/sort/share vẫn chờ BE-SOL-005.

## Dependency order

```
FE-TASK-001 (mount WorkflowBuilder + vá runWorkflow's projectId)
      │
      ▼
FE-TASK-002 (Library, dùng chung workflowView state FE-TASK-001 tạo)

FE-TASK-003 (paused status + Pause/Resume)     ─┐ độc lập với 001/002/003 lẫn nhau,
FE-TASK-004 (step-type vocabulary)             ─┘ có thể làm song song bất kỳ lúc nào

FE-TASK-005 (live streaming)                   ─── BLOCKED, không xếp vào track nào ở trên
```

- FE-TASK-001 → FE-TASK-002 là chuỗi có thật (FE-TASK-002 mở rộng `workflowView` union
  `'monitor'|'builder'` mà FE-TASK-001 tạo ra thành `'monitor'|'builder'|'library'`) — làm theo thứ
  tự này, không đảo ngược.
- FE-TASK-003 và FE-TASK-004 **hoàn toàn độc lập** với 001/002 và với nhau — có thể bắt đầu ngay lập
  tức, song song, không cần chờ gì. Cả 2 chỉ sửa `workflow-types.ts`/`ExecutionMonitor.tsx`/
  `WorkflowMonitor.tsx`/`StepEditor.tsx` — không chạm `WorkspaceLayout.tsx`/`WorkflowLibrary.tsx` mà
  001/002 sửa, nên không có rủi ro conflict merge đáng kể giữa 2 track.
- FE-TASK-005 đứng ngoài mọi track — không lên lịch cho tới khi 2 lớp phụ thuộc backend
  (`CR-FLOW-TASK-003` → `BE-SOL-006`) xong. Xem chi tiết lý do có file task dù blocked ở chính file
  FE-TASK-005.

## Phụ thuộc backend — tổng hợp theo mức độ chặn

| Task | RPC dùng | Trạng thái RPC hôm nay | Có chặn việc build UI không? |
|------|----------|------------------------|-------------------------------|
| FE-TASK-001 | `workflow.execute` | ✅ Tồn tại đầy đủ, kể cả `projectId` (chỉ frontend chưa gửi) | Không |
| FE-TASK-002 | `workflow.template.list` | ✅ Tồn tại (không có search/sort) | Không, cho phần Browse/Use |
| FE-TASK-002 | `SearchTemplates` + sharing RPCs | ❌ Chưa tồn tại (BE-SOL-005 📋 Proposed) | **Có, chỉ cho** phần search full-text/sort trending/Share/Clone thật |
| FE-TASK-003 | `workflow.pause`, `workflow.resume` | ✅ Tồn tại đầy đủ | Không |
| FE-TASK-004 | Không có RPC (type + dropdown only) | — | Không |
| FE-TASK-005 | Kênh event `task.activity:{id}`/`workflow.activity:{id}` + `subscribeRuntimeEvent` | ❌ Chưa tồn tại ở bất kỳ lớp nào (client lẫn backend) | **Có, chặn hoàn toàn** |

Giống task-graph series cùng đợt: không có task nào (trừ FE-TASK-005) bị chặn hoàn toàn bởi backend
chưa xong. FE-TASK-002 là task duy nhất có 1 phần con (search/share) phải tạm giới hạn ở
`workflow.template.list` — không lùi lịch cả task vì việc này, đúng cách FE-TASK-004 (task-graph
series) xử lý phần list/revoke/share-link của Grant modal.

## Không thuộc phạm vi các task ở đây

Xem mục "Not in scope" của
[FE-SOL-001](../solutions/FE-SOL-001-frontend-builder-library-pause-resume.md) và
[FE-SOL-002](../solutions/FE-SOL-002-execution-live-streaming.md) — cụ thể: không tự thiết kế lại
backend event schema, không thêm `action`/`parallel` step type trước khi backend merge, không xây
continuous stdout streaming (thuộc phạm vi agent series's `SOL-AG-TG-002`).
