# TASK-BE-STORAGE-005: Audit handler thật vs `Unimplemented*` cho read-path dev-server/ssh

**Solution:** BE-SOL-STORAGE-002 | **CR:** CR-STORAGE-006
**Service:** `infra-fleet-service`
**Depends on:** Không (làm trước, kết quả quyết định scope các task sau)
**Status:** ✅ DONE — 2026-09-07

---

**Kết quả thực tế:** Đọc trực tiếp `internal/adapter/grpc/server.go` và các
usecase liên quan (không giả định) — cả 6 RPC (`ListDevServers`,
`IsDevServerConnected`, `ListTerminalSessions`, `GetTerminalAgentStatus`,
`ListSshTargets`, `GetSshState`) đều là handler thật, đọc từ Postgres qua
usecase riêng, không RPC nào là `Unimplemented*`. `DevServer` proto message
**không** có field `bootstrap_status` — cột health/bootstrap status tồn tại
thật trong DB (`infra.dev_servers.status`, từ migration 0007) nhưng chưa
được map vào `domain.DevServer`/proto message; ghi nhận đây là gap riêng
(không thuộc scope TASK-BE-STORAGE-006/009), cần 1 task mới trước khi
`bootstrap.ts`'s hydrate có thể dùng `ListDevServers`/`GetDevServer` trực
tiếp. BUG-013 (team grants bị bỏ qua trong `devServer.listForUser`) xác
nhận **còn mở** (status PARTIAL trong bug doc), là blocker đã biết cho việc
coi `ListDevServers` là nguồn tin cậy đầy đủ cho user được cấp quyền qua
team. Không có RPC nào là stub nên không cần tạo task con
`TASK-BE-STORAGE-005b`. Bảng audit đầy đủ đã ghi vào
`BE-SOL-STORAGE-002.md` dưới heading `## Audit results (TASK-BE-STORAGE-005)`.
Đây là task điều tra thuần túy, không có code/test để chạy.

## Mục tiêu

Đây là task **điều tra**, không phải viết code mới — xác nhận trước khi
tin cậy CR-STORAGE-006's read-path, theo đúng cảnh báo ở BE-SOL-STORAGE-002
§6 ("không giả định — audit riêng cần thiết").

## Việc cần làm

1. Với mỗi RPC trong danh sách sau, đọc trực tiếp
   `backend-go/services/infra-fleet-service/internal/adapter/grpc/server.go`
   (hoặc file tương đương) — xác nhận handler trả dữ liệu thật từ
   Postgres, không phải `return nil, status.Error(codes.Unimplemented, ...)`:
   - `ListDevServers`
   - `IsDevServerConnected`
   - `ListTerminalSessions`
   - `GetTerminalAgentStatus`
   - `ListSshTargets`
   - `GetSshState`
2. Xác nhận `DevServer` message (proto) có field `bootstrap_status` — nếu
   có, `bootstrap.ts`'s hydrate (FE-TASK-STORAGE-013) dùng luôn
   `ListDevServers`/`GetDevServer`, không cần RPC riêng.
3. Đối chiếu [BUG-013](../../../bugs/missing-v3/BUG-013-devserver-listforuser-team-grants-ignored.md)
   — xác nhận còn mở hay đã fix; nếu còn mở, ghi rõ đây là **blocker** cho
   việc coi `ListDevServers`/`devServer.listForUser` là nguồn tin cậy cho
   user được cấp quyền qua team (không chỉ owner trực tiếp).

## Output của task này

1 bảng cập nhật trong `BE-SOL-STORAGE-002.md` (hoặc 1 file audit riêng
`docs/audits/` nếu team quy ước vậy) — với mỗi RPC ở trên: ✅ handler thật /
❌ còn stub, kèm file:line xác nhận. Nếu bất kỳ RPC nào là stub, tạo thêm 1
task con `TASK-BE-STORAGE-005b-implement-<rpc-name>` trước khi
TASK-BE-STORAGE-008 (wscompat wiring) có thể coi read-path hoàn chỉnh.

## Verify

Không có lệnh build/test — đây là code reading task. Kết quả là 1 bảng xác
nhận, không phải diff code.

## Blocking

TASK-BE-STORAGE-008 (wscompat wiring cho `devServer.*`/`ssh.*`) không nên
bắt đầu tới khi task này xác nhận xong danh sách handler thật.
