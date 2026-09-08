# BUG-AGENT-TASKV1-005: `agent/` vs `desktop/` — với backend-go, SSH-relay giờ tự thân trong `agent/` (tin tốt); nhưng `desktop/`'s copy vẫn thiếu `agent.execPrompt`/`shell.exec`/`notification.send` — vẫn là rủi ro thật cho Node backend đang chạy production

## Mức độ: 🟡 MEDIUM (đã thu hẹp đáng kể so với đánh giá gốc, nhưng chưa đóng hoàn toàn)

## Tóm tắt

`compliance-audit-2026-08-15.md` §1 phát hiện: binary `relay-ssh` thật được
deploy tới remote host được build từ `desktop/src/relay/relay.ts`
(`desktop/config/scripts/build-relay.mjs`), KHÔNG PHẢI từ
`agent/src/relay/relay.ts` — và kết luận mọi fix ở `agent/` "có nguy cơ
không tới được production nếu dev server dùng SSH-relay mode". Đây là phát
hiện cấu trúc quan trọng nhất trong toàn bộ audit `specs/agent/api/`, và
prompt yêu cầu audit này đánh giá ảnh hưởng của nó tới cả 4 bug trên
(OrcaTask/Task Execute/Streaming/Workflow).

**Kết luận sau khi đọc code thật hôm nay (2026-09-08, mới hơn audit gốc gần
1 tháng): finding này đã LỖI THỜI theo 1 hướng quan trọng và VẪN ĐÚNG theo 1
hướng khác — cần tách rõ theo backend nào đang nói tới.**

## Phát hiện mới: backend-go's SSH-relay KHÔNG dùng `desktop/` nữa — dùng `agent/`'s stdio entry point của chính nó

`agent/src/relay/agent-entry.ts` (dòng 8-11, comment tự ghi) liệt kê 3 mode:
```
direct-websocket  — Agent connects outbound to Orca Server (default)
relay-websocket   — Orca Server connects inbound to Agent (behind NAT/firewall)
stdio             — stdin/stdout wired directly to an SSH exec channel by
                     infra-fleet-service (the Go backend); no WS dial or
                     listen at all, SSH is the transport & trust boundary
```

`main()` (dòng 52-63): khi `process.argv.includes('--stdio')`, gọi
`connectStdio(config, tools, log)` từ `agent-connection-stdio.ts` — file này
xác nhận (dòng 1-13, 182-197): `connectStdio` dùng **đúng `createSession`
từ `agent-session.ts`** — **CÙNG session/dispatch pipeline (Part A đầy đủ,
`agent-rpc-dispatch.ts`) mà `direct-websocket`/`relay-websocket` dùng** —
chỉ khác transport (byte stream qua stdin/stdout thay vì WebSocket frame).

Xác nhận độc lập (agent điều tra riêng, đọc `backend-go/services/
infra-fleet-service/internal/adapter/devserveragent/client.go`,
`main.go`, `sshrelay/`): `infra-fleet-service`'s `ConnectionModeRelaySSH`
thật sự **SFTP-deploy `agent/out/agent.js` (build từ `agent/`, không phải
`desktop/`) rồi launch `node agent.js --stdio` qua SSH exec channel** —
wire thật trong `main.go` qua `WithRelaySSH(provisioner)`, không phải code
chết.

**Ý nghĩa:** với backend-go (đích của cả 3 hệ Task theo
`specs/backend-go/bugs/task-v1/`), **không còn 2 cây code phân kỳ nữa** —
cả 3 connection mode (`direct-websocket`, `relay-websocket`, `relay-ssh`
qua `--stdio`) đều chạy **cùng 1 bundle `agent/out/agent.js`**, cùng
`agent-rpc-dispatch.ts` đầy đủ (bao gồm `agent.execPrompt`, `shell.exec`,
`notification.send`, `ai.complete`, `ai.provider.*` — toàn bộ danh sách
`compliance-audit-2026-08-15.md` §2 từng liệt kê "missing on Part B"). Điều
này **phủ định trực tiếp** lo ngại gốc của compliance audit áp dụng cho
backend-go: **mọi fix ở agent/ (bao gồm 4 bug trên trong thư mục này) ĐỀU
tới được production của backend-go, bất kể connection mode**, vì không có
"Part B" tách biệt nữa đối với backend-go.

## Điều VẪN ĐÚNG — rủi ro thật, còn tồn tại, thu hẹp phạm vi còn lại: backend Node/Electron

`compliance-audit-2026-08-15.md`'s phát hiện gốc **vẫn đúng nguyên trạng**
đối với backend Node (`backend/src/main/...`) + Desktop Electron — đây là
backend **đang chạy production hôm nay** theo
`docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md`
(bảng so sánh: "Đang phục vụ: **Production** + toàn bộ Desktop Electron" cho
Node, "Chỉ `deploy/dev`" cho backend-go). Xác nhận lại bằng grep thật hôm
nay (không phải suy luận từ audit cũ):

```bash
$ grep -n "agent.execPrompt\|shell.exec\|notification.send" desktop/src/relay/*.ts
(không có kết quả — 0 hits)

$ grep -n "case 'agent.exec'" desktop/src/relay/agent-rpc-dispatch.ts
733:    case 'agent.exec': {
```

`desktop/src/relay/agent-rpc-dispatch.ts` (dòng 726-800) vẫn chỉ có
`case 'agent.exec'` — đúng shape cũ backend Node từng dùng **trước** khi
`StepExecutors.ts`/`ProfileAwareAgentSpawner.ts` đổi sang `agent.execPrompt`
(2026-08-16). Nghĩa là: nếu Node backend's `StepExecutors.executeAgent()`
(đã sửa gọi `agent.execPrompt`) chạy nhắm tới 1 dev server mà agent binary
thực tế đang chạy là **bản build từ `desktop/`** — kể cả qua direct-websocket
(không chỉ SSH-relay) nếu Electron tự bundle agent từ `desktop/` cho use
case đó — request sẽ nhận `MethodNotFound`, một regression **có thật, đang
chờ xảy ra** trên bất kỳ dev server nào chưa cập nhật lên bản agent mới nhất
build từ `agent/`.

**Chưa xác nhận được** (ngoài phạm vi audit này, cần 1 investigation riêng):
danh sách chính xác *khi nào* Electron desktop dùng agent build từ
`desktop/` (Electron tự bundle) so với khi nào dùng `agent/out/agent.js`
được deploy riêng — compliance audit gốc chỉ xác nhận chắc chắn trường hợp
`relay-ssh` (build script `build-relay.mjs` trỏ rõ `RELAY_ENTRY` tới
`desktop/src/relay/relay.ts`).

## Ảnh hưởng cụ thể tới 4 bug trên trong thư mục này

| Bug | Ảnh hưởng bởi divergence này? |
|---|---|
| BUG-AGENT-TASKV1-001 (OrcaTask, `agent.execPrompt`) | Backend-go: **KHÔNG** — dùng đúng 1 bundle agent/. Node backend qua `desktop/`-built agent: **CÓ** — sẽ fail `MethodNotFound` nếu dev server chưa cập nhật |
| BUG-AGENT-TASKV1-002 (Task Execute, `agent.spawn`) | Không liên quan trực tiếp — gap nằm ở thiếu wiring backend-go hoàn toàn (chưa có caller cả 2 phía), không phải divergence agent/desktop |
| BUG-AGENT-TASKV1-003 (streaming) | Backend-go: không liên quan (gap là kiến trúc unary Relay, không phải divergence code). Node backend: nếu tương lai làm streaming cho Node cũng phải nhớ đồng bộ `desktop/` |
| BUG-AGENT-TASKV1-004 (`workflow-service.AgentExecutor`) | **KHÔNG** liên quan tới divergence này — bug đó là backend-go tự gọi sai method name, độc lập với agent nào đang chạy |

## Đề xuất

1. **Cập nhật `compliance-audit-2026-08-15.md`** (hoặc thêm addendum) để ghi
   nhận phát hiện mới này — finding §1 của nó, viết trước khi
   `agent-connection-stdio.ts` tồn tại, nay cần phân biệt rõ "SSH-relay cho
   backend-go" (đã tự-chứa trong agent/, không còn vấn đề) vs "SSH-relay cho
   backend Node" (vẫn qua `desktop/`, vẫn phân kỳ) — nếu không, người đọc
   sau sẽ tưởng lo ngại vẫn áp dụng đều cho mọi trường hợp.
2. Vì `specs/backend-go/bugs/task-v1/` framing 3 hệ Task là tính năng
   backend-go, và CR-FLOW-TASK-004 đã lên kế hoạch retire Node backend —
   rủi ro còn lại (mục "Điều VẪN ĐÚNG") sẽ tự triệt tiêu khi Pha 3/4 của
   CR-FLOW-TASK-004 hoàn tất. Không cần đồng bộ `desktop/` riêng cho 3 hệ
   Task này nếu team chấp nhận chúng chỉ chạy chính thức trên backend-go từ
   đầu (tức: không cố gắng làm OrcaTask/Task Execute/Workflow Orchestration
   hoạt động qua Node backend + SSH-relay dev server nào chưa cập nhật) —
   đây là quyết định phạm vi cần product/tech-lead xác nhận, không phải kỹ
   thuật thuần tuý.
3. Nếu ngược lại 3 hệ Task cần chạy được trên Node backend trong lúc chờ
   cutover (một số user vẫn ở Node backend theo CR-FLOW-TASK-004 Pha 2/3),
   cần đồng bộ tối thiểu `agent.execPrompt`/`shell.exec`/`notification.send`
   sang `desktop/src/relay/agent-rpc-dispatch.ts` — 3 case này đã có sẵn
   implementation tham khảo 1:1 trong `agent/`, việc port không cần thiết
   kế mới, chỉ cần copy có kiểm tra.

## Tham khảo

- [`specs/agent/api/compliance-audit-2026-08-15.md`](../../api/compliance-audit-2026-08-15.md) §1 — phát hiện gốc, viết trước khi `agent-connection-stdio.ts` tồn tại.
- [`docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md`](../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md) — xác nhận Node backend vẫn là production hôm nay, kế hoạch cutover 4 pha.
- BUG-AGENT-TASKV1-001/002/003/004 (cùng thư mục) — đối chiếu ảnh hưởng ở bảng trên.

## Trích dẫn file:line

- `agent/src/relay/agent-entry.ts:8-11,52-63` — 3 mode, nhánh `--stdio`.
- `agent/src/relay/agent-connection-stdio.ts:1-13,182-197` — `connectStdio` dùng chung `createSession`/`agent-session.ts` với các mode WS.
- `backend-go/services/infra-fleet-service/internal/adapter/devserveragent/client.go:132-143,180-214` — `getOrCreateSession` switch theo `ConnectionMode`, `getOrProvisionSession` gọi `sshProvisioner.Provision` (deploy `agent/out/agent.js`, launch `--stdio`).
- `backend-go/services/infra-fleet-service/cmd/server/main.go:120-128` — `WithRelaySSH(provisioner)` wire thật trong production wiring.
- `desktop/src/relay/agent-rpc-dispatch.ts:726-800` — vẫn chỉ có `case 'agent.exec'`, xác nhận chưa đồng bộ `agent.execPrompt`.
- `desktop/config/scripts/build-relay.mjs` (trích dẫn từ compliance-audit-2026-08-15.md §1, chưa đọc lại trong audit này) — `RELAY_ENTRY` trỏ `desktop/src/relay/relay.ts` cho backend Node's `relay-ssh`.
