# CR-FLOW-TASK-004 — Cutover sang backend-go: Postgres tập trung, retire Node/SQLite cho 3 hệ Task

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-FLOW-TASK-004 |
| **Tên** | Đưa `backend-go` (Postgres) thành nguồn sự thật duy nhất cho OrcaTask/Task Execute/Workflow Orchestration ở production; retire backend Node/SQLite |
| **Loại** | Migration / Architecture |
| **Priority** | 🔴 P0 — điều kiện tiên quyết để thỏa yêu cầu "mọi thông tin lưu vào Postgres tập trung, không SQLite" |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-08 |
| **Trạng thái** | 🔵 Proposed — chưa triển khai |
| **Phụ thuộc** | Cổng nghiệm thu: mọi mục "❌/🟡" trong [specs/backend-go/bugs/task-v1](../../../../specs/backend-go/bugs/task-v1/README.md) phải chuyển "✅", cộng [CR-FLOW-TASK-001..003](./CR-FLOW-TASK-001-three-engine-execution-architecture.md) đã triển khai (để không cutover sang 1 kiến trúc thiếu liên kết) |
| **Tác động** | `deploy/prod/docker-compose.yml`, `desktop/src/main/task/*`, `desktop/src/main/workflow/*`, `desktop/src/main/runtime/rpc/methods/orchestration*.ts`, `backend/src/main/task|workflow/*` (bản sao Node/Web mode) |

---

## Bối cảnh & Vấn đề

Khảo sát thực tế (không phải giả định) cho thấy **2 backend chạy song song**
cho cùng 3 hệ Task:

| | Backend Node (`desktop/src/main/task|workflow/*-rpc-handler.ts`, bản sao ở `backend/src/main/`) | `backend-go` (task/workflow/orchestration-service) |
|---|---|---|
| Storage | SQLite cục bộ qua `IConnectionPool` | Postgres, database-per-service, cùng 1 Postgres instance (`docker-compose.yml`, `postgres-init-databases.sh`) — **không có SQLite ở đâu trong backend-go** (grep xác nhận 0 kết quả) |
| Đang phục vụ | **Production** (`deploy/prod/docker-compose.yml`, image `orca-server`) + toàn bộ Desktop Electron | Chỉ `deploy/dev/docker-compose.yml` (17 service, session-cookie multi-user mode, `ORCA_MULTI_USER=1`) |
| Độ phủ RPC | Đầy đủ hơn cho `task.*` (có `create` thật) | Đầy đủ hơn cho `workflow.*` (`template.update`/`pause`/`resume` mà Node **không có**); `orchestration.*` gần như trống (chỉ `dispatchShow`) |

`backend-go` tự nhận đang ở giai đoạn **"scaffold"**
(`backend-go/docs/execution-plan.md`) — đây không phải bug ẩn, mà là trạng
thái migration đang dang dở đã biết. Vấn đề là: **không có kế hoạch cutover
bằng văn bản** — không rõ điều kiện nào để chuyển production sang backend-go,
khiến 2 backend tiếp tục phân kỳ (ví dụ frontend's `useWorkflow.ts` đã viết
theo shape của backend-go cho `template.update`, method này **không tồn tại**
trên Node — lỗi runtime chắc chắn xảy ra trên production hôm nay, xem
`specs/frontend/bugs/task-v1`).

## Giải pháp đề xuất — Cutover theo 4 pha

### Pha 0 — Đóng băng phân kỳ (ngay lập tức, không cần code)
Mọi thay đổi RPC contract mới cho `task.*`/`workflow.*`/`orchestration.*` từ
nay chỉ được viết theo shape của **`backend-go`** (không viết thêm theo Node)
— tài liệu hoá quy tắc này trong `specs/backend-go/api/` để chặn phân kỳ
tiếp diễn trong lúc cutover chưa xong.

### Pha 1 — Đóng gap chức năng (điều kiện: `bugs/task-v1` sạch)
Toàn bộ mục ❌/🟡 trong `specs/backend-go/bugs/task-v1/` (và các
BUG-TG/BUG-WF/BUG-AG gốc mà nó tham chiếu) được implement. Không cutover
sớm hơn mốc này — cutover khi còn gap chức năng nghĩa là **giảm** chức năng
cho người dùng, không phải nâng cấp hạ tầng.

### Pha 2 — Dual-read / Shadow traffic (staging trước, prod sau)
`api-gateway` (đã có sẵn ở backend-go) nhận traffic thật ở `deploy/dev`;
mở rộng sang 1 bản staging ánh xạ 1:1 dữ liệu production (không phải dữ liệu
giả) để so sánh kết quả `task.*`/`workflow.*` giữa 2 backend trên cùng input
trong 1-2 tuần, log sai khác thay vì chặn traffic — không migrate dữ liệu
SQLite→Postgres tự động (mỗi bên có id space riêng theo thiết kế
`orchestration-service.md §2.1`; task/workflow tồn tại trước cutover ở
Node **không cần** portable sang backend-go, coi là dữ liệu lịch sử đóng
băng, chỉ task/workflow tạo **sau** cutover mới ở backend-go).

### Pha 3 — Flip production
`deploy/prod/docker-compose.yml` chuyển từ image `orca-server` (Node) sang
compose stack của `deploy/dev` (17 service backend-go) cho đúng 3 domain
`task`/`workflow`/`orchestration` trước — không nhất thiết flip toàn bộ hệ
thống 1 lần (backend-go có nhiều service hơn 3 domain này). Frontend đổi
target theo [CR-FLOW-TASK-005](./CR-FLOW-TASK-005-frontend-unified-task-execution-ui.md).

### Pha 4 — Retire code Node
Xoá `desktop/src/main/task/task-rpc-handler.ts`, `desktop/src/main/workflow/
workflow-rpc-handler.ts`, `desktop/src/main/runtime/rpc/methods/
orchestration*.ts` và bản sao ở `backend/src/main/task|workflow/*` — chỉ sau
khi Pha 3 chạy ổn định tối thiểu 1 chu kỳ release đầy đủ (rollback window).

## Rủi ro

- **Desktop Electron** (không phải web multi-user) hiện luôn dùng backend
  Node nội bộ (IPC), không phải "deploy" theo nghĩa server — Pha 3 cho
  desktop cần 1 quyết định riêng (có bundle backend-go vào desktop app, hay
  desktop luôn point tới 1 backend-go server từ xa?) — **chưa quyết định
  trong CR này**, cần 1 ADR riêng trước khi Pha 3 áp dụng cho desktop.
- Id-space không portable (Postgres task-service id ≠ SQLite OrcaTask id) —
  người dùng có task cũ trên Node sẽ **không thấy** chúng sau cutover nếu
  không có kế hoạch import riêng — Pha 2 cố tình không giải quyết, cần quyết
  định sản phẩm (chấp nhận mất lịch sử, hay viết 1 script migrate 1 lần).

## Acceptance Criteria

- [ ] Pha 0: quy tắc "RPC mới viết theo shape backend-go" được ghi vào `specs/backend-go/api/` và review-checklist của PR liên quan `task.*`/`workflow.*`/`orchestration.*`.
- [ ] Pha 1: `specs/backend-go/bugs/task-v1/README.md`'s bảng trạng thái 100% ✅.
- [ ] Pha 2: báo cáo shadow-traffic (staging) đính kèm dưới dạng task trong `specs/backend-go/crs/v3/flow-task/tasks/` khi thực hiện, với tỷ lệ sai khác < ngưỡng thống nhất trước khi sang Pha 3.
- [ ] Pha 3: `deploy/prod/docker-compose.yml` trỏ `task.*`/`workflow.*`/`orchestration.*` traffic sang backend-go; rollback plan bằng văn bản (revert compose) được test thật ít nhất 1 lần trước go-live.
- [ ] Pha 4: `git log` xác nhận xoá 3 file Node handler + bản sao `backend/`, `detect_changes({scope: "compare", base_ref: "main"})` xác nhận không còn caller nào trỏ tới chúng.
