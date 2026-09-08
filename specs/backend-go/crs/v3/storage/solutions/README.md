# backend-go Solutions — Frontend Storage Consolidation

**CRs:** [docs/crs/v3/storage/](../../../../../docs/crs/v3/storage/README.md)
**Frontend counterpart:** [specs/frontend/crs/v3/storage/solutions/](../../../../frontend/crs/v3/storage/solutions/README.md)

## Solutions

| Solution | CR | Service | Status |
|---|---|---|---|
| [BE-SOL-STORAGE-001](./BE-SOL-STORAGE-001-user-profile-json-columns.md) | CR-STORAGE-001, CR-STORAGE-003, CR-STORAGE-004 (phần a, b) | `tenant-service` | 🔲 Designed — chưa implement |
| [BE-SOL-STORAGE-002](./BE-SOL-STORAGE-002-dev-server-agent-hydration-and-health.md) | CR-STORAGE-006, CR-STORAGE-007 | `infra-fleet-service`, `orchestration-service` | 🔲 Designed — chưa implement |
| [BE-SOL-STORAGE-003](./BE-SOL-STORAGE-003-connection-reconnect-resume-contract.md) | CR-STORAGE-008 (phần b) | `infra-fleet-service`, `orchestration-service` | 🔲 Designed — chưa implement |

## Hai track — khác service, độc lập kỹ thuật

BE-SOL-STORAGE-001 nhắm `tenant-service` (dữ liệu preference cá nhân
**chưa từng** có nơi lưu ở backend-go — cần cột JSON mới). BE-SOL-002/003
nhắm `infra-fleet-service`/`orchestration-service` (dữ liệu dev-server/
agent-session **đã có** chủ sở hữu backend-go thật — chỉ thiếu read-path/
health-RPC/quy tắc reconnect). Không phụ thuộc chéo bắt buộc giữa 2 track;
xem [docs/crs/v3/storage/README.md](../../../../../../docs/crs/v3/storage/README.md#hai-track-riêng-biệt-trong-nhóm-cr-này)
cho sơ đồ đầy đủ.

## Vì sao chỉ 1 solution cho 3 CR ở BE-SOL-STORAGE-001

CR-STORAGE-001 (keybindings/UI-local/saved-server-list), CR-STORAGE-003
(full `GlobalSettings` sync), và CR-STORAGE-004 phần a/b
(`workspaceSession`/`accountsDevServer`) đều cần **đúng 1 loại thay đổi
hạ tầng ở backend-go**: thêm cột JSON opaque per-user vào
`tenant.user_profiles` (+ 1 bảng phụ cho `workspaceSession`, vì nó cần
khoá thêm theo host), cùng 1 cặp gRPC method tham số hoá, cùng 1 namespace
wscompat mới. Tách thành 3 file sẽ lặp lại y hệt thiết kế migration/
repository — xem BE-SOL-STORAGE-001's mục 1 để biết lý do gộp chi tiết
hơn.

## CR-STORAGE-002 và CR-STORAGE-005 không có solution ở đây

- **CR-STORAGE-002** (Zustand `persist` middleware) là thay đổi **thuần
  frontend** — adapter gọi vào RPC backend-go đã có (từ BE-SOL-STORAGE-001),
  không cần thêm gì ở backend-go. Xem
  [FE-SOL-STORAGE-002](../../../../frontend/crs/v3/storage/solutions/FE-SOL-STORAGE-002-zustand-persist-backend-storage.md).
- **CR-STORAGE-005** (dọn dẹp diagnostic module) chỉ đụng
  `frontend/src/renderer/src/lib/*.ts` — không có phần backend-go nào.

## Những gì KHÔNG thiết kế trong nhóm CR này

`orca.saved-instances` (CR-STORAGE-004 phần c) — theo phân tích trong
chính CR, đây là dữ liệu bootstrap **trước khi** biết kết nối tới backend-go
nào, nên không có 1 "backend-go instance" cụ thể nào để lưu vào. CR đề
xuất 2 hướng thay thế (export/import thủ công, hoặc đồng bộ qua 1 danh
tính cloud-linked xuyên-instance nếu có) — cả 2 đều cần quyết định sản
phẩm riêng trước khi mở CR/solution kế tiếp; không thiết kế ở đây.

## Thứ tự implement khi bắt tay vào

### Track 1 — `tenant-service`

```
1. BE-SOL-STORAGE-001 (backend-go) — migration + gRPC + wscompat, xong trước
2. FE-SOL-STORAGE-001/003/004 (frontend) — hybrid client wrapper gọi RPC mới ở (1)
3. FE-SOL-STORAGE-002 (frontend) — Zustand persist middleware, gắn vào RPC đã có ở (1)/(2)
4. FE-SOL-STORAGE-005 (frontend) — dọn dẹp, độc lập, làm bất cứ lúc nào
```

### Track 2 — `infra-fleet-service`/`orchestration-service`

```
1. BE-SOL-STORAGE-002 (backend-go) — xác nhận/hoàn thiện read-path đã có +
   RPC health mới (GetFleetConnectivitySummary) — không phụ thuộc track 1
2. FE-SOL-STORAGE-006 (frontend) — hydrate store slices từ (1), UI connectivity-status
3. BE-SOL-STORAGE-003 (backend-go) — state machine reconnect-resume
   (connections/terminal_sessions/dispatch_contexts) — nên làm sau (1)/(2)
   để có dữ liệu hydrate + kênh báo lỗi kiểm chứng hành vi
4. FE-SOL-STORAGE-007 (frontend) — tách auth-failure/logout (độc lập, làm
   sớm được) + phần resume UX (phụ thuộc (3))
```
