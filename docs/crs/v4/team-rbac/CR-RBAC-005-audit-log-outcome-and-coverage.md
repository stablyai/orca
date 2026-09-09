# CR-RBAC-005 — Audit log: thêm outcome/ip, phủ hết mọi service

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-RBAC-005 |
| **Tên** | Mở rộng `AuditEntry` (outcome, ip_address) + audit hoá OPA deny ở project/task/annotation-service |
| **Loại** | Feature Completion |
| **Priority** | 🟡 P1 (compliance — F32 nêu rõ "audit trail" là 1 trong các vấn đề gốc cần giải quyết) |
| **Effort** | Medium (2–3 ngày) |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Chưa triển khai |
| **Tác giả** | Rà soát backend-go + frontend audit log theo yêu cầu hoàn thiện F32 |
| **Tác động HLD** | C3.1 |
| **Tác động Features** | F32 |
| **Phụ thuộc** | Không — độc lập, nên xong trước CR-RBAC-001 (Admin UI cutover cần schema mới) |

---

## Bối cảnh & Vấn đề

F32 §Phase 1 Database Schema yêu cầu `orca_audit_log(action, resource_type, resource_id, outcome, ip_address, timestamp)` và acceptance criterion "Audit log table với filter theo user/action/outcome".

`backend-go`'s `domain.AuditEntry` (`backend-go/services/auth-service/internal/domain/audit.go:23`) thực tế chỉ có `{ID, TenantID, ActorID, Action, Target, OccurredAt}`:

- **Thiếu `outcome`** (allow/deny) — không thể phân biệt "user cố làm X và bị từ chối" với "user làm X thành công", vốn là giá trị bảo mật cốt lõi của audit log.
- **Thiếu `ip_address`** — trớ trêu là chính **legacy Electron** `AuditLogger` (`backend/src/main/auth/audit-logger.ts`, `desktop/src/main/auth/audit-logger.ts`) đã có field này từ trước, nhưng không được port sang khi viết lại ở backend-go.
- `QueryAuditLog` (`query_audit_log.go:26`) chỉ filter được `tenant_id` + `since` + phân trang — không filter được actor/action/resource_type/outcome vì cột không tồn tại.
- **Chỉ auth-service tự audit hành động của chính nó** (`UpdateUserRole`, …). Không có bằng chứng bất kỳ quyết định allow/deny nào của OPA ở `project-service`/`task-service`/`annotation-service`/`infra-fleet-service` được ghi vào audit log — nghĩa là hành vi quan trọng nhất cần audit theo đúng tinh thần F32 ("ai kết nối server nào", "ai bị từ chối làm gì") **hoàn toàn không được ghi lại** ở các service đó.
- Phía frontend (Admin UI hiện tại, Hệ B — xem CR-RBAC-001), `AuditEntry`/`AuditFilter` (`admin-api-client.ts:45-59`) cũng không có `outcome`, và **kể cả `userId`/`userEmail` đã có sẵn trên entry cũng chưa được biến thành filter control nào trên UI** — hiển thị dạng cột nhưng không lọc được.

## Giải pháp đề xuất

1. **Schema**: thêm `Outcome ('allowed'|'denied')` và `IPAddress string` vào `domain.AuditEntry`; migration thêm 2 cột trên bảng `auth.audit_log` (Postgres, backend-go).
2. **`QueryAuditLog`**: mở rộng filter — `actor_id`, `action`, `resource_type` (tách từ `Target` nếu `Target` hiện đang gộp type+id, xác nhận khi cài đặt), `outcome`.
3. **Audit hoá OPA deny/allow ở các service còn thiếu**: thêm lệnh gọi `audit.Append` (qua 1 client dùng chung, có thể cần expose `AppendAuditEntry` như 1 RPC nhỏ trên `AuthService` để các service khác gọi cross-service, vì audit log hiện sống trong auth-service's Postgres schema) tại:
   - `project-service`'s `requireProjectAccess`/`requireRepoAccess` (cả nhánh allow và deny — F32 muốn thấy cả 2, không chỉ deny).
   - `task-service`'s permission resolution (grant hierarchy).
   - `annotation-service`'s author-or-admin check.
   - `infra-fleet-service`'s `ListDevServersForUser`/dev-server connect action — đây chính là "ssh.connect" mà F32 nêu làm ví dụ đầu tiên.
4. Ghi `ip_address` tại điểm request vào api-gateway (nơi có IP thật của client) — truyền qua context xuống usecase, không tin tưởng header IP tự khai từ phía service nội bộ.
5. Frontend audit UI (sau CR-RBAC-001, sống trong `AdminOrgConsole`): thêm filter theo `actor`/`outcome` bên cạnh `action`/date-range đã có.

## Changes Required

| File | Thay đổi |
|------|---------|
| `backend-go/services/auth-service/internal/domain/audit.go` | Thêm `Outcome`, `IPAddress` |
| `backend-go/services/auth-service/internal/adapter/postgres/audit_repository.go` | Migration + query mới |
| `backend-go/services/auth-service/internal/usecase/query_audit_log.go` | Filter mở rộng |
| `backend-go/services/auth-service/internal/adapter/grpc/server.go` | RPC nhận filter mới; cân nhắc thêm `AppendAuditEntry` RPC nội bộ cho service khác gọi |
| `backend-go/services/project-service/internal/usecase/authorization.go` | Gọi audit append tại `requireProjectAccess`/`requireRepoAccess` |
| `backend-go/services/task-service/internal/domain/grant.go` (hoặc usecase liên quan) | Audit hoá quyết định permission |
| `backend-go/services/infra-fleet-service/...` | Audit hoá `ssh.connect`/dev-server access |
| `backend-go/services/api-gateway/...` | Truyền IP client thật xuống context |
| Frontend audit UI (`AdminOrgConsole`'s tab Audit, sau CR-RBAC-001) | Filter actor/outcome |

## Không thuộc phạm vi CR này

- Di trú dữ liệu `orca_audit_log` SQLite cũ (xem CR-RBAC-001's "Không thuộc phạm vi").
- Audit log cho hành động phía client thuần UI (vd. mở 1 trang) — chỉ audit các quyết định permission/RBAC có ý nghĩa an ninh, đúng tinh thần F32.

## Tiêu chí chấp nhận

- [ ] `AuditEntry` có `outcome`+`ip_address`; `QueryAuditLog` filter được actor/action/resource_type/outcome.
- [ ] Ít nhất 1 audit entry được ghi cho mỗi lần OPA deny ở project-service/task-service/annotation-service/infra-fleet-service (test tích hợp).
- [ ] Admin UI audit log lọc được theo user và outcome (đúng nguyên văn acceptance criterion của F32).

## Impact analysis (gitnexus)

| Symbol | Direction | Risk | Impacted |
|---|---|---|---|
| `AuditEntry` (`auth-service/internal/domain/audit.go`) | upstream | LOW | 14 (1 direct, ảnh hưởng process `run` ở `auth-service/cmd/server/main.go`) |

Risk LOW nhưng đụng tới 1 execution flow (`run`) — chạy lại `detect_changes({scope:"compare", base_ref:"main"})` sau khi sửa, và chạy `impact` cho từng service usecase mới thêm audit call trước khi merge.

## Liên quan

- [F32-team-rbac.md](../../../features/F32-team-rbac.md) §Phase 1 Database Schema, §Tiêu chí chấp nhận
- CR-RBAC-001 (Admin UI cutover phụ thuộc schema này)
