# CR-STORAGE-008 — Ngữ nghĩa reconnect: frontend giữ trạng thái khi đăng nhập lại, agent tiếp tục việc cũ khi kết nối lại

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-STORAGE-008 |
| **Tên** | (a) Tách "auth failure" khỏi "logout" — chỉ xoá storage khi logout có xác nhận; (b) hợp đồng reconnect-resume cho `connectionId`/`ptyId`/dispatch ở backend-go |
| **Loại** | Architectural Change / Bug Fix |
| **Priority** | P0 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-07 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Yêu cầu user: "nếu frontend bị ngắt kết nối và đăng nhập lại → vẫn phải giữ trạng thái trước đó (trừ khi logout và xác nhận đóng mọi kết nối); nếu agent bị ngắt kết nối → kết nối lại vẫn phải tiếp tục công việc trước đó" |
| **Tác động HLD** | Web auth bootstrap, `infra-fleet-service` (connection/terminal-session lifecycle), `orchestration-service` (dispatch/circuit-breaker) |
| **Tác động Features** | Đăng nhập lại sau mất kết nối, Logout, Terminal/agent session sau khi dev server rớt mạng |

---

## Bối cảnh & Vấn đề gốc

### (a) Frontend: auth-failure hôm nay hành xử giống hệt logout — xoá sạch mọi trạng thái

`browser-storage-catalog.md` mục 4 xác nhận **cả 2 đường** dùng chung 1
hành vi `.clear()` không phân biệt:

| Trigger | file:line | Hành vi hiện tại |
|---|---|---|
| Web-mode auth-failure handler (token hết hạn, 401, mất kết nối tạm thời) | `renderer/src/web/main-web-bootstrap.tsx:92,97` | `.clear()` toàn bộ `localStorage`+`sessionStorage`, redirect `/login` |
| Explicit user logout | `renderer/src/hooks/useLogout.ts:50,55` | `.clear()` toàn bộ `localStorage`+`sessionStorage` |

Hệ quả: 1 lần token hết hạn giữa buổi làm việc (không phải người dùng chủ
động logout) xoá luôn `orca.saved-instances`, `orca.accountsDevServer.<id>`,
`orca.web.workspaceSession.v1` — đăng nhập lại xong, người dùng phải chọn
lại server, chọn lại tài khoản dev server, và **mất hết tab/layout đang
mở**. Đây đúng là hành vi user yêu cầu sửa: auth-failure + đăng nhập lại
phải **khôi phục đúng trạng thái cũ**, không coi như logout.

### (b) Backend-go: chưa có hợp đồng "reconnect thì resume", chỉ mới có health tracking

`infra-fleet-service.md` §8 tự nêu đây là **câu hỏi thiết kế còn mở**:

> "`relay-websocket` mode (agent dials in) requires session affinity or
> connection handoff — flag this as an open design question for the Go
> rewrite's implementation phase, not resolved by this doc."

Và domain model hiện tại (`connections.status`:
`establishing|established|degraded|closed`) có đủ trạng thái trung gian
(`degraded`) nhưng **chưa có tài liệu nào định nghĩa**: khi 1 dev server
mất kết nối rồi kết nối lại trong 1 khoảng thời gian ngắn, nó có được gán
lại **đúng** `connectionId`/`terminal_sessions`/`dispatch_contexts` cũ hay
không — nếu không, mọi terminal/agent-work đang chạy trên dev server đó bị
"orphan" một cách âm thầm dù về mặt vật lý agent process trên dev server có
thể vẫn đang chạy bình thường.

## Giải pháp đề xuất

### (a) Frontend — tách rõ 2 đường, chỉ xoá khi có xác nhận logout

```ts
// renderer/src/web/main-web-bootstrap.tsx — MODIFY: bỏ .clear(), chỉ redirect
function handleAuthFailure() {
  // KHÔNG xoá localStorage/sessionStorage — token hết hạn không phải logout.
  // orca.saved-instances / accountsDevServer / workspaceSession giữ nguyên,
  // để khi đăng nhập lại, mọi trạng thái (server đã chọn, tab đang mở,
  // dev-server/agent state hydrate lại theo CR-STORAGE-006) khôi phục y hệt.
  redirectToLogin({ preserveClientState: true })
}

// renderer/src/hooks/useLogout.ts — MODIFY: thêm bước xác nhận trước khi .clear()
async function logout() {
  const confirmed = await confirmDialog({
    title: 'Đăng xuất',
    message: 'Thao tác này sẽ đóng mọi phiên đang mở và quên các server đã lưu trên trình duyệt này. Tiếp tục?',
    confirmLabel: 'Đăng xuất và đóng mọi kết nối'
  })
  if (!confirmed) return
  await closeAllActiveSessions()   // MỚI — chủ động đóng agent/terminal session đang mở trước khi xoá state, tránh orphan phía backend-go
  localStorage.clear(); sessionStorage.clear()
  redirectToLogin({ preserveClientState: false })
}
```

**Không đổi** hành vi khi người dùng **chủ động bấm logout và xác nhận** —
đúng yêu cầu "trừ khi logout và xác nhận đóng mọi kết nối". Điểm mới duy
nhất ở nhánh logout là thêm bước xác nhận + gọi đóng session chủ động
trước khi xoá, để backend-go không phải tự suy luận "kết nối rớt do lỗi"
hay "người dùng chủ động đóng" (2 trường hợp cần xử lý khác nhau ở mục b).

### (b) Backend-go — hợp đồng reconnect-resume cho `infra-fleet-service`/`orchestration-service`

1. **`connections`**: khi mất kết nối, chuyển `degraded` (không chuyển
   thẳng `closed`) trong 1 khoảng grace-period — tái dùng ý tưởng
   `relayGracePeriodSeconds` đã có ở `SshTarget` phía TS
   (`agent/src/shared/fleet-config-parser.ts:45`, mặc định 86400s trong
   `fleetServerToSshTarget`) làm cơ sở chọn giá trị mặc định phía
   backend-go — dev server kết nối lại trong cửa sổ này được gán **lại
   đúng** `connectionId` cũ, không tạo mới. Chỉ chuyển `closed` khi hết
   grace-period, hoặc khi frontend chủ động gọi đóng (logout đã xác nhận ở
   mục a).
2. **`terminal_sessions`**: **không** đóng `ptyId` khi connection chuyển
   `degraded` — chỉ đóng khi connection chuyển `closed`. Khi dev server
   reconnect trong lúc `degraded`, dùng `WaitTerminalSession`/
   `FocusTerminalSession` (đã tồn tại trong
   `infrafleet_grpc.pb.go`) để client reattach vào **đúng** `ptyId` cũ —
   agent process/terminal đang chạy trên dev server (nếu vẫn sống) tiếp
   tục hiển thị đúng output, không bị coi là phiên mới.
3. **`dispatch_contexts`** (orchestration-service): phân biệt rõ 2 loại
   lỗi — **lỗi transport** (mất kết nối reconnect được trong grace-period)
   và **lỗi dispatch thật** (agent trả lỗi/timeout khi đang thực thi).
   Chỉ loại thứ 2 mới tăng `failure_count`. Một `connections.status =
   degraded` đơn thuần **không** tự động gọi `FailDispatch` — tránh trip
   circuit-breaker (`failure_count >= 3`) chỉ vì mạng chập chờn, đúng yêu
   cầu "agent bị ngắt kết nối → kết nối lại vẫn phải tiếp tục công việc
   trước đó" thay vì bị coi là thất bại.
4. **Khi logout đã xác nhận** (mục a gọi `closeAllActiveSessions()`):
   backend-go coi đây là tín hiệu đóng **chủ động**, chuyển thẳng
   `connections.status = closed` + đóng toàn bộ `terminal_sessions` liên
   quan ngay — không chờ grace-period, không giữ lại gì để resume (đúng ý
   "logout và xác nhận đóng mọi kết nối").

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Chọn giá trị grace-period mặc định cho `connections.degraded → closed` | Cần quyết định sản phẩm | Đề xuất tham chiếu `relayGracePeriodSeconds` hiện có nhưng **không** mặc định copy nguyên giá trị 86400s (24h) cho mọi loại transport — cần review riêng theo từng `transport_mode` |
| `relay-websocket` mode's session affinity/connection handoff (đã flag "open" ở TDD §8) | **Cao** | CR này định nghĩa **ngữ nghĩa mong muốn** (giữ `connectionId`, không trip breaker do lỗi transport) nhưng **không tự giải quyết** bài toán hạ tầng "pod nào giữ transport sống" — đó là 1 thiết kế triển khai riêng, cần review kỹ trước khi implement |
| Phân biệt lỗi transport vs. lỗi dispatch đòi hỏi `orchestration-service`'s `FailDispatch` caller biết rõ nguồn gốc lỗi | Trung bình | Cần rà lại toàn bộ call site hiện gọi `FailDispatch` để đảm bảo không gọi nhầm khi nguyên nhân là mất kết nối tạm thời |
| Auth-failure không xoá storage có thể giữ lại state của **sai người dùng** nếu 2 người dùng chung 1 trình duyệt | Thấp-Trung bình | Cần đối chiếu: nếu re-auth trả về `user_id` khác với phiên trước, PHẢI coi như đổi user (xử lý như logout, không giữ state) — ghi rõ điều kiện này khi implement, không giả định luôn cùng 1 user |

## Không thuộc phạm vi CR này

- Cơ chế báo lỗi/health hiển thị lên UI khi đang ở trạng thái `degraded` —
  xem [CR-STORAGE-007](./CR-STORAGE-007-bidirectional-error-health-reporting.md).
- Hydrate lại dữ liệu dev-server/agent sau khi đăng nhập lại — xem
  [CR-STORAGE-006](./CR-STORAGE-006-centralize-dev-server-agent-state-backend-go.md)
  (CR-008 chỉ đảm bảo dữ liệu **không bị xoá nhầm**; CR-006 đảm bảo có
  đường **đọc lại** nó).
- Thiết kế lại giao thức `relay-websocket` cho session affinity/connection
  handoff ở mức hạ tầng (load balancer/sticky session) — chỉ định nghĩa
  ngữ nghĩa mong muốn, không thiết kế hạ tầng triển khai.

## Liên quan

- `specs/frontend/storage/browser-storage-catalog.md` mục 4
- `specs/backend-go/tdd/services/infra-fleet-service.md` §4, §8
- `specs/backend-go/tdd/services/orchestration-service.md` §4, §8
- `frontend/src/renderer/src/web/main-web-bootstrap.tsx:92,97`
- `frontend/src/renderer/src/hooks/useLogout.ts:50,55`
- `agent/src/shared/fleet-config-parser.ts:45` (`relayGracePeriodSeconds`, tiền lệ tham chiếu)
- [CR-STORAGE-006](./CR-STORAGE-006-centralize-dev-server-agent-state-backend-go.md), [CR-STORAGE-007](./CR-STORAGE-007-bidirectional-error-health-reporting.md)
