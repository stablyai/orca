# BUG-FE-TASKV1-008 — Root cause tổng hợp: frontend viết pha trộn theo 2 shape backend khác nhau, lỗi tuỳ theo deploy target

**Mức độ:** 🔴 Critical
**Status:** 🔴 Open
**Module:** `frontend/src/renderer/src/hooks/useWorkflow.ts`, `hooks/useTask.ts`, `runtime/runtime-rpc-client.ts` (điều phối target)
**Phát hiện:** 2026-09-08 (audit frontend vs 3 hệ Task: OrcaTask/Task Execute/Workflow Orchestration)

---

## Mô tả

Đây là bug tổng hợp, gom root cause chung của
[BUG-FE-TASKV1-007](./BUG-FE-TASKV1-007-workflow-builder-rpc-shape-mismatch.md)
và một phần [BUG-FE-TASKV1-001](./BUG-FE-TASKV1-001-orcatask-crud-va-tree-navigation.md):
codebase frontend hiện tại **không có 1 quy tắc nhất quán** về việc viết RPC
call theo shape của backend nào, dẫn tới tình trạng pha trộn ngay trong cùng
1 file:

- `useWorkflow.ts`'s `runWorkflow()` (dòng 82) viết theo shape `backend-go`
  (`templateId`, không `definition`) — nhưng 2 backend Node đang chạy thật
  production yêu cầu ngược lại (`definition` bắt buộc, không `templateId`).
- Cùng file, `saveTemplate()` (dòng 46-73) nhánh update lại viết đúng shape
  Node (`definition: { steps: local.steps ?? [] }`, dòng 59) — tức là 2 hàm
  trong CÙNG MỘT hook, viết bởi 2 đợt fix khác nhau (fix `BUG-FE-RPC-006` chỉ
  sửa `saveTemplate()`, không lan sang `runWorkflow()`), theo 2 chuẩn khác
  nhau.
- `useTask.ts`/`TaskDetail.tsx`/`TaskPromptEditor.tsx` gọi `task.execute`/
  `task.update`/`task.getDependencies` — các RPC này hiện có shape tương thích
  cả 2 backend (không phát hiện lệch ở phạm vi audit này), nhưng không có gì
  đảm bảo lệch trạng thái này được duy trì khi 1 trong 2 backend đổi schema
  độc lập trong tương lai, vì **không có kiểm tra type-safety chung** giữa
  frontend và cả 2 backend — mỗi bên tự định nghĩa Zod schema/proto message
  riêng, không share 1 nguồn types.

Bảng so sánh đầy đủ từ `CR-FLOW-TASK-004` (đã xác nhận lại bằng đọc code
thật trong quá trình audit này):

| | Backend Node (`desktop/src/main`, `backend/src/main` — 2 bản gần giống nhau, lệch nhẹ) | `backend-go` |
|---|---|---|
| Đang phục vụ | **Production** (`deploy/prod`) + Desktop Electron | Chỉ `deploy/dev` |
| `task.*` | Đầy đủ hơn — có `task.create` thật | `CreateTask` có, nhưng thiếu RPC cây (`GetChildren`/`GetAncestors`/`GetSubtree` chỉ là domain-internal, xem BUG-FE-TASKV1-001) |
| `workflow.*` | `template.update`/`pause`/`resume` **chỉ có ở bản server** (`backend/src/main`), **thiếu ở Desktop Electron** (`desktop/src/main`, chỉ 7/10 method) | Có `UpdateTemplate` tương đương (chưa audit chi tiết ở đây) |
| `orchestration.*` | Không áp dụng (Engine 2 không có ở Node) | Gần như trống — chỉ `dispatchShow` xác nhận có UI dùng thật |

Vì không có "Pha 0" (quy tắc đóng băng: mọi RPC mới chỉ viết theo 1 shape cụ
thể) như `CR-FLOW-TASK-004` đề xuất, code mới thêm vào từ nay vẫn có nguy cơ
tiếp tục lệch theo bất kỳ hướng nào tuỳ người viết đang test trên deploy
target nào lúc đó (dev thường chạy `backend-go`, nên dễ viết theo shape đó
mà không nhận ra production dùng Node).

## Hậu quả

- Lỗi runtime xảy ra hoặc không tuỳ theo **deploy target đang chạy backend
  nào** — cùng 1 đoạn code, test pass ở `deploy/dev` (backend-go) nhưng fail
  ở production (Node), hoặc ngược lại. Đây là loại bug khó bắt nhất trong CI
  nếu CI chỉ test với 1 trong 2 backend.
- Không có cách nào ở tầng type-check (TypeScript) phát hiện các lệch shape
  này — `callRuntimeRpc` nhận payload dạng object tự do, không có schema
  dùng chung giữa FE/BE để compiler bắt lỗi thiếu field.
- Sửa từng bug lẻ (như BUG-FE-TASKV1-007) không ngăn được lệch mới phát sinh
  — cần 1 quy tắc/gate ở tầng review, không chỉ vá từng chỗ.

## Bằng chứng

```
frontend/src/renderer/src/hooks/useWorkflow.ts:82        → runWorkflow() viết theo shape backend-go (templateId, không definition)
frontend/src/renderer/src/hooks/useWorkflow.ts:56-62      → saveTemplate() (nhánh update) viết theo shape Node (definition: { steps }) — cùng file, 2 chuẩn khác nhau
frontend/src/renderer/src/hooks/useWorkflow.ts:52-55      → comment tự thú tham chiếu BUG-FE-RPC-006 — xác nhận đây là 1 đợt fix RIÊNG LẺ, không phải quy tắc áp dụng toàn file
backend/src/main/workflow/workflow-rpc-handler.ts:103-110,268-271 → workflow.template.update tồn tại ở bản server
desktop/src/main/workflow/workflow-rpc-handler.ts:1-9     → chỉ 7/10 method — 2 bản Node lệch nhau, không chỉ FE lệch BE
```

## Đề xuất fix

1. Áp dụng ngay "Pha 0" của `CR-FLOW-TASK-004`: mọi RPC contract mới cho `task.*`/`workflow.*`/`orchestration.*` từ nay chỉ viết theo shape `backend-go` — ghi thành quy tắc tường minh trong `specs/backend-go/api/` + checklist review PR, để không phát sinh lệch mới trong lúc cutover chưa xong.
2. Sửa các điểm lệch đã biết theo shape Node (đang phục vụ traffic thật) trước — xem hành động cụ thể ở BUG-FE-TASKV1-007 — KHÔNG đổi sang shape backend-go ngay bây giờ vì sẽ làm hỏng production đang chạy Node.
3. Dài hạn: theo đúng lộ trình `CR-FLOW-TASK-004` (cutover 4 pha) + `CR-FLOW-TASK-005` (frontend chuyển hẳn sang gọi backend-go sau Pha 3) — không tự ý cutover từng phần không có kế hoạch.
4. Cân nhắc sinh types dùng chung từ `.proto`/Zod schema (codegen) để compiler bắt được lệch field ngay lúc build, thay vì phát hiện lúc runtime qua audit thủ công như bug này.
5. Đồng bộ lại 2 bản Node (`desktop/src/main` vs `backend/src/main`) — hiện đang lệch nhau (`workflow.template.update`/`pause`/`resume` chỉ có ở 1 bên) dù được mô tả là "bản sao" — đây là rủi ro độc lập với FE nhưng ảnh hưởng trực tiếp tới việc FE có thể viết "1 shape Node" hay phải phân biệt theo target Desktop/Web.

## Tham khảo

- Backend liên quan: [BUG-TASKV1-008](../../../backend-go/bugs/task-v1/BUG-TASKV1-008-dual-backend-routing-and-postgres-compliance.md) (đối chiếu đầy đủ RPC surface 2 backend)
- CR liên quan: docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md (kế hoạch cutover 4 pha, giải pháp dài hạn)
- CR liên quan: docs/crs/v3/flow-task/CR-FLOW-TASK-005-frontend-unified-task-execution-ui.md (frontend chuyển hẳn theo backend-go sau cutover)
- Liên quan: BUG-FE-TASKV1-007 (biểu hiện cụ thể, nghiêm trọng nhất của root cause này)
