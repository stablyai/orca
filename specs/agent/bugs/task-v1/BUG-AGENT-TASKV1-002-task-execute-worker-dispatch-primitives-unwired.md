# BUG-AGENT-TASKV1-002: Primitive `agent.spawn`/`sendInput`/`output`/`kill` tồn tại và đúng ở agent/, nhưng KHÔNG có đường nào ở backend-go gọi tới hoặc nhận notification — Task Execute dispatch hôm nay không chạm agent/ ở đâu cả

## Mức độ: 🔴 CRITICAL (đối với khả năng triển khai Task Execute — không phải regression, mà là "chưa từng được nối dây")

## Tóm tắt

Câu hỏi cần trả lời: khi `orchestration-service` dispatch 1 sub-task cho 1
"terminal-hosted AI-agent worker" (mô tả trong
`specs/backend-go/tdd/services/orchestration-service.md:21,67-68`), nó có
đủ RPC phía `agent/` để spawn PTY, gửi input, đọc output, biết khi nào xong
không?

**Kết luận:** Ở tầng `agent/`, primitive `agent.spawn`/`agent.sendInput`/
`agent.kill` + notification `agent.output`/`agent.exited` **tồn tại thật,
đã sửa đúng theo BUG-AG-ORCH-001/002/004/006** (xác nhận lại bằng code thật
bên dưới — không phải suy diễn từ audit cũ). Nhưng câu hỏi "đủ cho Task
Execute" không thể trả lời "có" một cách trọn vẹn, vì **chưa có đầu bên kia
để dùng chúng**: `orchestration-service` (nơi phải là caller) **không gọi
`infra-fleet-service` ở bất kỳ đâu** (xác nhận bằng grep toàn bộ
`internal/`, 0 kết quả — khớp
[BUG-TASKV1-005](../../../backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md)),
và `infra-fleet-service` **không có RPC gRPC streaming nào bọc
`agent.spawn`'s notification** (`agent.output`/`agent.exited`) — nó chỉ có
streaming cho `pty.*` (`AttachPty`) và `browser.*` (`AttachScreencast`).
Vậy dù agent/ đã sẵn sàng, **không có cách nào hôm nay để 1 process
backend-go nhận được stream output của 1 `agent.spawn` PTY** — kể cả khi
`orchestration-service` được viết để gọi `agent.spawn` qua `Relay` (unary),
nó sẽ nhận `{type:'spawn.accepted'}` ngay lập tức rồi **không bao giờ** thấy
output/exit code, vì cả hai đều đến dưới dạng notification ngoài luồng RPC
mà `Relay` (unary request/response) không có cơ chế nhận.

## Xác nhận agent/ đã sửa đúng (đối chiếu BUG-AG-ORCH-001/002/004/006)

| Bug cũ | Trạng thái ghi trong file cũ | Xác nhận lại bằng code thật hôm nay |
|---|---|---|
| BUG-AG-ORCH-001 (thiếu `agent.sendInput`) | ✅ RESOLVED | ✅ đúng — `agent-rpc-dispatch-agent-exec.ts:50` `case 'agent.sendInput'`, đọc `PTY_REGISTRY`, `entry.pty.write(data)` (`agent-spawner.ts`, hàm `handleAgentSendInput`) |
| BUG-AG-ORCH-002 (`agent.kill` luôn SIGTERM) | không có file trạng thái tường minh trong bug gốc, chỉ nhắc trong AUDIT-REPORT | ✅ đã sửa — `agent-spawner.ts:648-651`: `const rawSignal = ...; const signal = rawSignal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'` — tôn trọng `params.signal`, comment tự ghi `// ORCH-002: Respect the caller's signal choice` |
| BUG-AG-ORCH-004 (thiếu codex/opencode trong `resolveAgentSpec`) | không có file trạng thái tường minh | ✅ đã sửa — `AGENT_SPECS` (`agent-spawner.ts:227-291`) nay có `claude`(230)/`codex`(243)/`gemini`(259)/`opencode`(280)/`ollama`(291) — đủ 5 |
| BUG-AG-ORCH-006 (`agent.output` gửi như response thay vì notification) | ✅ RESOLVED | ✅ đúng — `agent-spawner.ts:604`: `sendAgentSpawnNotification('agent.output', {ptyId, data: base64(data)})`; dòng 621: `sendAgentSpawnNotification('agent.exited', {ptyId, exitCode})`. `sendAgentSpawnNotification` (dòng 138-145) gửi `{jsonrpc:'2.0', method, params}` — **không có `id`** — đúng chuẩn JSON-RPC notification |
| BUG-AG-ORCH-009 (resume session) | ⏸ DEFERRED, "Partial: resumeId field added" | Chưa verify sâu trong audit này (ngoài phạm vi Task Execute cốt lõi) — `AgentSpawnRequest` cần xác nhận riêng nếu Task Execute cần resume worker sau restart coordinator |
| BUG-AG-ORCH-010 (switch account) | ⏸ DEFERRED | Vẫn treo — nếu 1 worker bị rate-limit giữa dispatch, không có cơ chế switch account tự động ở agent/ lẫn backend-go |

→ Đây là ĐIỂM KHÁC BIỆT so với các bug cũ: các bug đó viết theo góc nhìn
"agent-lifecycle" (1 agent chạy tương tác, khởi động từ UI). Từ góc nhìn
**Task Execute** (orchestration coordinator dispatch **nhiều** worker chạy
nền, không có UI người dùng theo dõi trực tiếp), câu hỏi không phải "các RPC
này có đúng không" (chúng đúng) mà là "**có ai gọi/nhận chúng không**" — và
câu trả lời là không, ở cả hai đầu.

## Gap mới — không có trong các bug cũ vì chúng chưa tồn tại lúc đó

### 1. `orchestration-service` chưa từng gọi `infra-fleet-service`

```bash
$ grep -rn "infrafleet\|Relay(" backend-go/services/orchestration-service/internal/ | grep -v _test.go
(không có kết quả)
```

Khớp hoàn toàn với `BUG-TASKV1-005`'s phát hiện: không có `StartCoordinatorRun`,
không có ticker/poll loop — dispatch tới agent chưa được viết ở tầng gọi.
Đây **không phải bug của `agent/`** — ghi ở đây để nối 2 đầu bức tranh: nếu
mai sau `StartCoordinatorRun` được implement và cố gọi `agent.spawn` qua
`infra-fleet-service.Relay`, nó sẽ đụng ngay Gap 2 dưới đây.

### 2. `infra-fleet-service` không có kênh nhận `agent.output`/`agent.exited`

`infra-fleet-service`'s `Relay`/`RelayByDevServer` RPC là **unary**
(`backend-go/proto/orca/infrafleet/v1/infrafleet.proto:47`:
`rpc Relay(RelayRequest) returns (RelayResponse)`) — một request, một
response duy nhất. `agent.spawn`'s response thật là
`{type:'spawn.accepted'}` ngay lập tức (agent-rpc-catalog-runtime.md dòng
87) — mọi output/exit code sau đó đến dưới dạng **notification** trên cùng
kết nối WS, hoàn toàn ngoài phạm vi mà `Relay`'s unary request/response nắm
bắt được.

So sánh với 2 luồng streaming THẬT SỰ đã tồn tại ở `infra-fleet-service`:

```protobuf
// backend-go/proto/orca/infrafleet/v1/infrafleet.proto:104,117
rpc AttachPty(stream PtyClientFrame) returns (stream PtyServerFrame);
rpc AttachScreencast(stream ScreencastClientFrame) returns (stream ScreencastServerFrame);
```

Cả hai đều là **bidirectional streaming gRPC**, có usecase riêng
(`infra-fleet-service/internal/usecase/spawn_terminal_session.go`,
`attach_pty.go` — map sang `pty.create`/`pty.attach`/`pty.data`/`pty.write`;
`ports.go:310-322`'s `StreamScreencast` — map sang `browser.screencastStart`
+ notification). **Không có RPC tương đương cho `agent.spawn`** — grep xác
nhận (`grep -rn "agent.spawn\|agent.output\|agent.exited" backend-go/ | grep
-v _test.go`) chỉ ra 2 chỗ, cả hai là **comment tham chiếu ý tưởng**, không
phải RPC/usecase thật:
- `infra-fleet-service/internal/usecase/teardown_connection.go:60` — comment nhắc "kill agent.spawn PTYs"
- `infra-fleet-service/internal/usecase/ports.go:314` — comment ví von `browser.screencastStart` "mirroring how git.execStream/agent.spawn ack immediately then push further data via notify" — chỉ là phép so sánh thiết kế, không phải triển khai thật

→ **Không có `AttachAgentSpawn`-kiểu RPC nào tồn tại.** Nếu
`orchestration-service` gọi `agent.spawn` qua `Relay` hôm nay, nó sẽ nhận
đúng `{type:'spawn.accepted'}` một lần rồi im lặng vĩnh viễn — không có
cách nào biết agent đã in gì, hay đã thoát chưa, trừ khi polling bằng RPC
khác (không có RPC "get PTY status by ptyId" cho `agent.spawn`'s PTY_REGISTRY
— `pty.listProcesses` (Part A) chỉ liệt kê PTY của **daemon PTY** khác biệt
với `agent.spawn`'s in-process `PTY_REGISTRY`, xem
`agent-rpc-catalog-runtime.md`'s bảng `pty.*` Part A — 2 registry tách biệt).

### 3. Đường tắt khả thi đã tồn tại sẵn — chưa ai dùng cho Task Execute

`pty.create` (Part A, `agent-rpc-dispatch-pty.ts` → `pty-daemon-client.ts`
→ `pty-agent-bridge.ts`) đã nhận `command`+`commandDelivery:'provider'`+`env`
(agent-rpc-catalog-runtime.md dòng 24, 64-81) — nghĩa là: viết 1 lệnh khởi
chạy CLI agent (`claude ...`) làm `command`, kèm API key đã giải mã vào
`env`, là **spawn được 1 AI agent chạy trong PTY** mà KHÔNG cần dùng
`agent.spawn` — và `pty.create`/`pty.attach` **ĐÃ CÓ** đường streaming thật
100% qua `AttachPty` (dùng chung với tính năng Terminal UI hiện tại,
`channels_terminal.go`'s `terminal.create`). Đường này:
- ✅ Streaming output theo thời gian thực — đã chứng minh hoạt động (dùng
  cho Terminal UI production).
- ✅ Có sẵn RPC gRPC (`AttachPty`) — không cần thêm RPC mới ở
  `infra-fleet-service`.
- ❌ KHÔNG có credential-resolution tích hợp sẵn như `agent.spawn`/
  `agent.execPrompt`'s `buildAgentEnv()` — `orchestration-service` sẽ phải
  tự giải mã API key và nhét vào `env` của `pty.create` (rủi ro tương tự
  ADR-008 gap `compliance-audit-2026-08-15.md` §3 mục 3 đã ghi: backend
  phải cầm plaintext key).
- ❌ Không có model resolution (`resolveAgentSpec`) tự động — caller phải tự
  biết binary/args đúng cho từng model.

**Đây là phát hiện xây dựng, không phải bug**: ghi lại để bất kỳ ai
implement `StartCoordinatorRun`'s dispatch logic biết có 2 lựa chọn kiến
trúc (dùng `agent.spawn` — cần xây thêm 1 RPC streaming mới ở
`infra-fleet-service`; hay tái dùng `pty.create`+`AttachPty` — có streaming
sẵn nhưng thiếu credential/model resolution, phải tự làm ở tầng
orchestration-service) thay vì mặc định nghĩ `agent.spawn` là đường duy
nhất.

## Ảnh hưởng

`StartCoordinatorRun`/dispatch logic của `orchestration-service` (khi được
viết) **không thể** dùng `agent.spawn` "as-is" qua `Relay` unary mà đạt được
mô tả "terminal-hosted AI-agent worker" với quan sát tiến độ — bắt buộc phải
đi kèm 1 trong hai:
(a) 1 RPC streaming mới ở `infra-fleet-service` bọc `agent.spawn`'s
notification (tương tự `AttachPty`), hoặc
(b) chuyển sang dùng `pty.create`+`AttachPty` (đã có sẵn, ít việc backend-go
phải làm hơn, nhưng cần tự lo credential injection).

## Đề xuất

- **agent/**: không cần sửa gì để "thêm khả năng" — cả hai đường (agent.spawn
  và pty.create) đã đủ primitive. Việc còn lại hoàn toàn ở backend-go
  (infra-fleet-service cần 1 RPC streaming mới, hoặc orchestration-service
  cần chọn dùng pty.create).
- Nếu team chọn hướng (a), khi thiết kế RPC streaming mới cho `agent.spawn`,
  tái dùng đúng notification shape đã có (`agent.output {ptyId,data(base64)}`,
  `agent.exited {ptyId,exitCode}`) — không đổi shape agent/ đang emit, chỉ
  cần 1 usecase/adapter mới ở `infra-fleet-service` subscribe đúng 2
  notification này trên session hiện có (giống cách `AttachScreencast` subscribe
  `browser.screencast*`).

## Tham khảo

- [`specs/backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md`](../../../backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md) — xác nhận `orchestration-service` chưa có `StartCoordinatorRun`/dispatch loop nào — bug này là tiền đề của audit này.
- [`specs/agent/bugs/agent-orchestration/BUG-AG-ORCH-001/002/004/006/009/010`](../agent-orchestration/) — trạng thái agent-side, xác nhận lại ở bảng trên.
- [`specs/agent/api/agent-rpc-catalog-runtime.md`](../../api/agent-rpc-catalog-runtime.md) — bảng `agent.*`, `pty.*` Part A, mục "AI-agent spawn output — No confirmed backend consumer found".
- [`specs/agent/crs/v3/project-workspace/solutions/SOL-AG-PW-001-execution-progress-reporting-design.md`](../../crs/v3/project-workspace/solutions/SOL-AG-PW-001-execution-progress-reporting-design.md) — thiết kế progress-reporting (chưa build), cùng kết luận "phải tái dùng kết nối relay hiện có, không mở kết nối thứ 2" — áp dụng y hệt cho Gap 2 ở đây.

## Trích dẫn file:line

- `agent/src/relay/agent-rpc-dispatch-agent-exec.ts:24,37,50` — case `agent.spawn`/`agent.kill`/`agent.sendInput`.
- `agent/src/relay/agent-spawner.ts:138-145,227-291,604,621,648-651` — `sendAgentSpawnNotification`, `AGENT_SPECS`, notification emit, signal handling.
- `backend-go/proto/orca/infrafleet/v1/infrafleet.proto:47,104,117` — `Relay` (unary) vs `AttachPty`/`AttachScreencast` (streaming).
- `backend-go/services/infra-fleet-service/internal/usecase/ports.go:295-322` — `AgentStatus`/`StreamScreencast`, không có tương đương cho `agent.spawn`.
- `backend-go/services/infra-fleet-service/internal/usecase/teardown_connection.go:60` — comment duy nhất còn nhắc `agent.spawn`, không phải RPC thật.
