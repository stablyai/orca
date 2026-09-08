# CR-STORAGE-004 — Backend hoá `workspaceSession`, `accountsDevServer`; giữ nguyên `saved-instances`

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-STORAGE-004 |
| **Tên** | Cơ chế lưu backend cho `orca.web.workspaceSession.v1`, `orca.saved-instances`, `orca.accountsDevServer.<id>` |
| **Loại** | Architectural Change |
| **Priority** | P1 (`workspaceSession`) / P2 (`accountsDevServer`) / Không áp dụng (`saved-instances`, xem bên dưới) |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-07 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Yêu cầu user: "orca.web.workspaceSession.v1 và orca.saved-instances và orca.accountsDevServer.<id> tất cả phải có cơ chế lưu ở backend" |
| **Tác động HLD** | Workspace session (tabs/layout), Accounts picker, Web client bootstrap |
| **Tác động Features** | Terminal tabs, split layout, Accounts (Claude/Codex) dev-server picker, web "saved server" picker |

---

## Bối cảnh & Vấn đề gốc

3 key được liệt kê trong
[`specs/frontend/storage/browser-storage-catalog.md`](../../../../specs/frontend/storage/browser-storage-catalog.md#4-auth--session--dev-server-connections)
và [`ui-settings-session-hybrid.md`](../../../../specs/frontend/storage/ui-settings-session-hybrid.md#session-namespace)
có 3 đặc điểm khác nhau — CR này xử lý riêng từng key thay vì gộp chung 1
giải pháp, vì **1 trong 3 key có ràng buộc kiến trúc khiến nó không thể**
lưu ở "backend" theo đúng nghĩa "1 backend-go instance cụ thể".

### (a) `orca.web.workspaceSession.v1` — có thể & nên backend hoá

`WorkspaceSessionState` (`frontend/src/shared/types.ts:1077-1141`): tab
đang mở, layout split, file đang edit theo worktree... Hiện **hoàn toàn
không có RPC nào** — pure localStorage
(`frontend/src/renderer/src/web/web-preload-api.ts:653-674`). Xoá
localStorage = mất hết tab/layout, không có đường khôi phục nào.

### (b) `orca.accountsDevServer.<environmentId>` — có thể & nên backend hoá

`frontend/src/renderer/src/runtime/accounts-dev-server-connection.ts:16-45`:
map `environmentId → devServerId` mặc định cho picker tài khoản Claude/
Codex. Hiện đơn giản chỉ là 1 key localStorage; comment trong code (dòng
10-15, theo audit) nói rõ đây là lựa chọn **chủ ý** không đi qua
`GlobalSettings`/server-authoritative state — nhưng bản thân dữ liệu (một
map nhỏ, không nhạy cảm) hoàn toàn phù hợp để backend hoá theo đúng pattern
CR-STORAGE-001/003.

### (c) `orca.saved-instances` — RÀNG BUỘC KIẾN TRÚC, không backend hoá được như 2 key trên

`hooks/useSavedOrcaInstances.ts:14-27`: danh sách **các server Orca
self-hosted khác nhau** mà trình duyệt này từng kết nối tới
(`OrcaInstance[]{id,label,url,team?,lastConnectedAt?}`) — dùng để hiển thị
picker **TRƯỚC KHI** người dùng chọn kết nối tới server nào, tức **trước
khi có bất kỳ phiên đăng nhập/kết nối backend-go nào tồn tại**. Đây là bài
toán con-gà-quả-trứng: "lưu ở backend-go" giả định đã biết backend-go nào để
gọi — nhưng chính key này tồn tại để giải quyết "chưa biết chọn server
nào". Backend hoá key này vào MỘT trong các server đó không giải quyết
được vấn đề (mất hết danh sách các server *khác*); backend hoá vào 1 dịch
vụ trung tâm hoàn toàn mới (một "Orca account service" độc lập với mọi
self-hosted instance) là khả thi về mặt kỹ thuật nhưng là 1 quyết định sản
phẩm/hạ tầng lớn hơn hẳn phạm vi "chuyển local storage sang backend-go
hiện có" — xem "Đề xuất cho (c)".

## Giải pháp đề xuất

### (a) `workspaceSession` — cột JSON mới, theo đúng pattern CR-STORAGE-001/003

Thêm cột `workspace_session_json` vào `tenant.user_profiles`, gRPC
`GetWorkspaceSession`/`SetWorkspaceSession`, wscompat
`session.getRemote`/`session.setRemote`/`session.patchRemote` (mirror
đúng shape `get`/`set`/`patch` hiện có ở `window.api.session`, chỉ đổi
backing store).

**Lưu ý khác biệt với (a)/(b) trong CR-STORAGE-001**: `session.patch` được
gọi rất thường xuyên (mỗi lần đổi tab/layout) — nên áp dụng debounce phía
client (giống `desktop/src/main/persistence.ts`'s "1s trailing / 5s
max-wait" đã dùng cho `orca-data.json`, xem
`ui-settings-session-hybrid.md`'s session section) trước khi gửi RPC, tránh
ngập backend-go với write nhỏ liên tục.

**Giữ nguyên `sessionStorageKeyForHost()`'s ý tưởng phân vùng theo host**
(`web-preload-api.ts:3730-3735`) — bản ghi `workspace_session_json` nên có
thêm 1 key phụ theo `hostId`/`environmentId` (không chỉ `user_id`), vì 1
user có thể có tab/layout khác nhau cho mỗi runtime environment họ dùng.

### (b) `accountsDevServer` — cột JSON nhỏ, cùng pattern

Cột `accounts_dev_server_json` (`Record<environmentId, devServerId>`), gRPC
`GetAccountsDevServerMap`/`SetAccountsDevServerMap`, wscompat
`accounts.getDevServerMap`/`accounts.setDevServerDefault`.

### (c) `saved-instances` — KHÔNG backend hoá trong CR này, đề xuất giải pháp thay thế

Đề xuất 2 lựa chọn, **cả 2 đều ngoài phạm vi triển khai của bộ CR
STORAGE-00x này** (cần quyết định sản phẩm riêng trước khi mở CR kế
tiếp):

1. **Giữ nguyên client-side, chỉ thêm export/import thủ công** — thêm nút
   "Export danh sách server" (tải xuống JSON)/"Import" trong Settings, để
   người dùng tự sao lưu khi đổi máy. Chi phí thấp, không đụng kiến trúc.
2. **Đồng bộ qua 1 danh tính xuyên-instance đã có sẵn** — nếu người dùng đã
   liên kết 1 "cloud-linked Orca profile"
   (`frontend/src/renderer/src/store/slices/orca-profiles-auth-actions.ts:13,42`,
   `createRuntimeCloudLinkedOrcaProfile`) — tức đã có 1 danh tính không
   gắn với riêng 1 self-hosted instance — thì `orca.saved-instances` CÓ
   THỂ đồng bộ qua chính flow đó. Cần xác nhận trước: `orca-profiles`'s
   "cloud-linked" backend hôm nay là gì (không phải `backend-go`'s
   `tenant-service` — chưa tìm thấy khái niệm "OrcaProfile" nào trong
   `backend-go` khi tra cứu cho CR này) — nếu đúng là 1 dịch vụ khác, CR
   backend hoá `saved-instances` phải nhắm vào đúng dịch vụ đó, không phải
   `tenant-service`.

**Trong CR-STORAGE-004 này: không thay đổi `saved-instances`** — giữ
nguyên `localStorage`, chỉ ghi nhận ràng buộc và 2 hướng đi ở trên cho
CR kế tiếp.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| `session.patch` tần suất cao | Trung bình | Cần debounce (xem trên); nếu bỏ qua, số lượng RPC write tăng đột biến so với hôm nay (0 RPC nào) |
| Phân vùng theo host cho `workspaceSession` | Trung bình | Thiết kế khoá bản ghi (`user_id` + `hostId`) cần khớp đúng ngữ nghĩa `sessionStorageKeyForHost()` hiện tại — sai sẽ làm lẫn lộn tab giữa các runtime environment khác nhau của cùng 1 user |
| `saved-instances` bị hiểu nhầm là "trong phạm vi" nếu chỉ đọc lướt README | Thấp | CR này cố tình tách rõ (c) ra khỏi (a)/(b) — xem lại mục "Không thuộc phạm vi" |

## Không thuộc phạm vi CR này

- Backend hoá `orca.saved-instances` — xem giải thích ràng buộc kiến trúc ở
  trên; cần 1 CR sản phẩm riêng sau khi chọn 1 trong 2 hướng đề xuất.
- Xây transport push để đồng bộ tab/layout **realtime** giữa nhiều tab
  trình duyệt/thiết bị đang mở cùng lúc — CR này chỉ đảm bảo có 1 bản sao ở
  backend-go để **khôi phục** khi mất localStorage, không đồng bộ live.
- Migrate hành vi tương tự cho desktop's `orca-data.json` — desktop đã có
  cơ chế bền cục bộ hoạt động tốt; không nằm trong yêu cầu gốc (yêu cầu chỉ
  nêu đích danh 3 key này, cả 3 hiện chỉ tồn tại ở nhánh web).

## Liên quan

- `specs/frontend/storage/browser-storage-catalog.md` (mục 4)
- `specs/frontend/storage/ui-settings-session-hybrid.md` (mục `session`)
- `frontend/src/renderer/src/hooks/useSavedOrcaInstances.ts`
- `frontend/src/renderer/src/runtime/accounts-dev-server-connection.ts`
- `frontend/src/renderer/src/web/web-preload-api.ts:653-674,3730-3759`
- `frontend/src/renderer/src/store/slices/orca-profiles-auth-actions.ts`
- [CR-STORAGE-001](./CR-STORAGE-001-local-app-storage-to-backend-go.md) (pattern chung dùng lại cho (a)/(b))
