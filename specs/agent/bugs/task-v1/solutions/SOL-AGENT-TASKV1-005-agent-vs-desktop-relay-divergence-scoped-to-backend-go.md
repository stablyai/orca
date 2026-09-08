# SOL-AGENT-TASKV1-005: Không cần action ở `agent/` — backend-go's 3 hệ Task đã tự-chứa trong `agent/`; rủi ro còn lại chỉ áp dụng cho `desktop/` (Node backend)

**Giải quyết:** [BUG-AGENT-TASKV1-005](../BUG-AGENT-TASKV1-005-agent-vs-desktop-relay-divergence-scoped-to-backend-go.md)

## Gap này nằm ở đâu?

**✅ Không nằm ở `agent/`, và cũng không cần action nào trong `agent/`.**

Xác nhận lại kết luận của bug gốc bằng đọc trực tiếp: với backend-go (đích
của cả 3 hệ Task — OrcaTask/Task Execute/Workflow Orchestration), cả 3
connection mode (`direct-websocket`, `relay-websocket`, `relay-ssh` qua
`--stdio`) đều chạy **cùng một** `agent/out/agent.js`, cùng
`agent-rpc-dispatch.ts` đầy đủ:

- `agent/src/relay/agent-entry.ts:8-11,52-63` — 3 mode, nhánh `--stdio` gọi
  `connectStdio`.
- `agent/src/relay/agent-connection-stdio.ts:1-13,182-197` — `connectStdio`
  dùng chung `createSession` (`agent-session.ts`) với mode WS — **không có
  "Part B" tách biệt cho backend-go**.
- `backend-go/services/infra-fleet-service/internal/adapter/devserveragent/client.go:132-143,180-214` —
  `ConnectionModeRelaySSH` SFTP-deploy đúng `agent/out/agent.js` (build từ
  `agent/`, không phải `desktop/`), launch `node agent.js --stdio`.

→ **Mọi fix trong 4 bug còn lại của thư mục này (001-004) tự động tới được
production của backend-go**, bất kể connection mode — không có nguy cơ "Part
B" thất lạc fix như `compliance-audit-2026-08-15.md` §1 từng lo ngại (finding
đó viết trước khi `agent-connection-stdio.ts` tồn tại).

## Rủi ro còn lại — ngoài phạm vi `agent/`, thuộc về `desktop/`

`desktop/src/relay/agent-rpc-dispatch.ts:726-800` (build cho Node/Electron
backend, backend **đang chạy production hôm nay** theo
`CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md`) vẫn chỉ
có `case 'agent.exec'` — chưa có `agent.execPrompt`/`shell.exec`/
`notification.send`. Đây là 1 cây code **khác** (`desktop/`, không phải
`agent/`) — nằm ngoài phạm vi mà thư mục `specs/agent/` (và audit này) có
thể tự sửa.

## Đề xuất — chỉ ghi chú, không hành động trong `agent/`

Task-brief yêu cầu: solution này chỉ cần "xác nhận backend-go/SSH-relay đã
ổn, phần còn lại (`desktop/`) ngoài phạm vi agent/, ghi rõ không cần action
nào trong `agent/`". Xác nhận đúng như vậy. 3 lựa chọn xử lý rủi ro
`desktop/` (đã liệt kê đầy đủ ở bug gốc, không lặp lại chi tiết, chỉ tóm
tắt để solution này khép kín):

1. Cập nhật `compliance-audit-2026-08-15.md` với addendum phân biệt rõ
   backend-go (đã ổn) vs Node backend (vẫn phân kỳ) — việc tài liệu, không
   phải code.
2. Chấp nhận 3 hệ Task (OrcaTask/Task Execute/Workflow) chỉ chạy chính thức
   trên backend-go — quyết định phạm vi, cần product/tech-lead, không phải
   kỹ thuật.
3. Nếu cần chạy trên Node backend trong lúc chờ `CR-FLOW-TASK-004` cutover:
   port `agent.execPrompt`/`shell.exec`/`notification.send`'s case sang
   `desktop/src/relay/agent-rpc-dispatch.ts` — có sẵn implementation tham
   khảo 1:1 trong `agent/`, không cần thiết kế mới. **Đây là việc của
   `desktop/`, không phải `agent/`** — nếu team quyết định làm, nên mở 1
   bug riêng dưới phạm vi `desktop/` (ngoài `specs/agent/`).

## Kết luận / Status

**✅ Không cần action ở `agent/`.** Không có code thay đổi nào được đề xuất
trong solution này. Việc duy nhất khuyến nghị là tài liệu hoá (mục 1) và 1
quyết định phạm vi sản phẩm (mục 2/3) — cả hai đều nằm ngoài `agent/`.

## Tham khảo

- [`docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md`](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md)
- [`specs/agent/api/compliance-audit-2026-08-15.md`](../../../api/compliance-audit-2026-08-15.md) §1

## Trích dẫn file:line (đối chiếu bug gốc, không đọc lại toàn bộ trong solution này)

- `agent/src/relay/agent-entry.ts:8-11,52-63`
- `agent/src/relay/agent-connection-stdio.ts:1-13,182-197`
- `desktop/src/relay/agent-rpc-dispatch.ts:726-800`
- `backend-go/services/infra-fleet-service/internal/adapter/devserveragent/client.go:132-143,180-214`
- `backend-go/services/infra-fleet-service/cmd/server/main.go:120-128`
