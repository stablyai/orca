# SOL-AG-FLOWTASK-001: Streaming stdout cho `agent.execPrompt` (CR-FLOW-TASK-003 — phần bị flag "ngoài phạm vi") — design only

> **📐 Design-only — chưa lên lịch triển khai, là điều kiện tiên quyết để
> CR-FLOW-TASK-003 hoàn thiện đầy đủ (không chặn CR-003's phần event rời
> rạc, chỉ chặn phần stdout liên tục).**

**CR:** [docs/crs/v3/flow-task/CR-FLOW-TASK-003](../../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-003-unified-task-activity-event-catalog.md)
— mục "Rủi ro / Không thuộc phạm vi": *"Không giải quyết streaming stdout
liên tục (PTY output real-time) — đã bị SOL-TG-04 flag là cần đổi `agent/` +
`infra-fleet-service`, ngoài phạm vi CR này."* Tài liệu này là phần thiết
kế "Phase D" bổ trợ cho khoảng trống đó — **không phải một CR mới**, không
đổi acceptance criteria của CR-FLOW-TASK-001..005.

**Tiền lệ trực tiếp:** [SOL-AG-PW-001](../../project-workspace/solutions/SOL-AG-PW-001-execution-progress-reporting-design.md)
(CR-PW-006 Phase D) — cùng loại gap (agent-side unary exec, cần streaming),
cùng mức độ "design-only vì cross-repo + connection hiện có không được
regress". Tài liệu này **không thiết kế lại** SOL-AG-PW-001 (đối tượng khác:
đó là `workflow-service`'s `agent_step_executor.go`/PTY-step; đây là
`task-service`'s `SimpleExecutor`/Engine 1 one-shot `agent.execPrompt`), chỉ
áp dụng đúng nguyên tắc thiết kế mà nó đã đặt ra cho một RPC khác.

**Phụ thuộc:** CR-FLOW-TASK-001 (`execution_links` — chỗ chunk cần persist/
mirror trạng thái), CR-FLOW-TASK-003 (event catalog + kênh WS
`task.activity:{taskId}` — chunk cuối cùng phải đổ vào đúng kênh này, không
phải kênh riêng).

---

## 1. Hiện trạng — vì sao `agent.execPrompt` chỉ trả 1 response cuối (đọc code thật)

### 1.1 `agent.execPrompt`'s handler tích luỹ toàn bộ output rồi mới resolve 1 lần

`agent/src/relay/agent-print-mode-exec.ts:124-163` (`handleAgentExecPrompt`):

```typescript
const result = await new Promise<PrintModeExecResult>((resolve) => {
  let stdout = ''
  let stderr = ''
  ...
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString('utf8')      // ← chỉ nối chuỗi, không gửi gì đi
  })
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString('utf8')
  })
  ...
  child.on('close', (code) => {
    finish({ stdout, stderr, exitCode: code, timedOut })   // ← resolve 1 LẦN DUY NHẤT
  })
})
...
return { jsonrpc: '2.0', id, result: { ...result, stepId } }   // dòng 177 — response cuối cùng
```

`child.stdout.on('data', ...)` không có bất kỳ side-effect nào ngoài nối
chuỗi — không có cap kích thước (khác `agent.execNonInteractive`'s "Output
capped 4MB/stream", `specs/agent/api/agent-rpc-catalog-runtime.md` dòng 92),
không có notification nào được gửi giữa chừng. Toàn bộ vòng đời request
(`agent-rpc-dispatch-agent-exec.ts:176-189`, case `'agent.execPrompt'`) là
unary thuần: 1 `rpc.id` vào, đúng 1 response JSON-RPC ra sau khi process CLI
thoát hoặc timeout (`MAX_TIMEOUT_MS = 15 * 60_000`, dòng 22).

Đây chính là dòng SOL-TG-04 đã trích dẫn khi flag gap này (dòng 364-366 của
SOL-TG-04): *"`agent.execPrompt`'s real contract... is fully synchronous:
one request, one final `{stdout, stderr, exitCode, timedOut}` response, no
incremental delivery."* — audit này đọc lại code thật và xác nhận đúng.

### 1.2 Không thể chỉ sửa `agent/` một mình — `agent-rpc-dispatch-agent-exec.ts`'s case không có quyền truy cập `ws`/`state`

So sánh với `pty.create` (đã hỗ trợ push, `agent-rpc-dispatch-pty.ts:30-43`):

```typescript
case 'pty.create': {
  const { handlePtyCreate } = await import('./pty-daemon-client')
  return (await handlePtyCreate(
    rpc.id, rpc.params ?? {}, log,
    makeNotifier(ws, state)          // ← notifier được truyền vào
  )) as JsonRpcResponse
}
```

`case 'agent.execPrompt'` (`agent-rpc-dispatch-agent-exec.ts:176-189`) gọi
`handleAgentExecPrompt(rpc.id, rpc.params ?? {}, config, log)` — **không**
truyền `ws`/`state`, nên `handleAgentExecPrompt` không có cách nào gọi
`makeNotifier()` (`agent-rpc-dispatch.ts:275-285`, cơ chế notification
JSON-RPC 2.0 một chiều — không có `id`, cùng `encodeDataFrame`/`WireState`
đã dùng cho response — đã tồn tại và đã dùng thật cho `pty.data`/`pty.exit`/
`fs.changed`, xem TDD-AG-02 §5). Đây **không phải** giới hạn của wire
protocol — cơ chế push đã có sẵn, dùng được ngay — chỉ là
`handleAgentExecPrompt` chưa được nối dây vào nó.

### 1.3 Ngay cả khi agent/ phát notification, `infra-fleet-service` hôm nay sẽ DROP nó (điểm chặn thật sự thứ 2)

Đọc `backend-go/services/infra-fleet-service/internal/adapter/devserveragent/`:

- `client.go:243` (`Client.Exec`) → `session.go`'s `session.call()` (dòng
  618-668): đăng ký đúng 1 `pendingCall` với `resultCh chan JSONRPCResponse`
  **buffer size 1** (dòng 630), gửi request, `<-resultCh` đúng 1 lần (dòng
  658-667) rồi return — không có vòng lặp nhận nhiều frame cho cùng 1
  request id.
- `session.go`'s `readLoop()` (dòng 241-282) tách 2 loại frame đến: có `id`
  → response, khớp vào `pending[id]` rồi xoá khỏi map (dòng 261-270); có
  `method` không `id` → notification, đi qua `routeNotification()` (dòng
  278-279, 319-328).
- `routeNotification()` (dòng 319-328) **chỉ nhận diện 2 họ method cứng**:
  `pty.data/pty.exit/pty.replay` (dòng 321, demux theo `ptySubs` — 1 map
  `map[string][]chan rawPtyNotification` khởi tạo dòng 77-83, TASK-183) và
  `browser.screencastReady/Frame/Ended/Error` (dòng 323, demux
  `screencastSubs` cùng pattern, dòng 85-95). **Bất kỳ method notification
  nào khác đều bị `default` case im lặng bỏ qua** (dòng 325-327, doc comment
  dòng 276-277: *"this client issues no general-purpose onRequest/
  onNotification handlers yet"*).

Kết luận: `Relay` gRPC method (`infra-fleet.proto` dòng 47:
`rpc Relay(RelayRequest) returns (RelayResponse)` — không có `stream`, xác
nhận unary end-to-end) và cơ chế bên dưới nó **không có đường dẫn nào** để
1 notification agent-side (dù agent/ có phát ra) tới được `task-service`'s
`SimpleExecutor` hôm nay — kể cả khi Mục 1.2 được vá, chunk vẫn bị
`infra-fleet-service` âm thầm drop cho tới khi `routeNotification` được mở
rộng. Đây là bằng chứng cụ thể hoá cho điều SOL-TG-04 đã flag ở mức khái
quát ("infra-fleet-service — a server-streaming gRPC endpoint..." — SOL-TG-04
dòng 374-381) — audit này xác nhận **chính xác điểm nào trong code sẽ chặn
im lặng** nếu chỉ sửa `agent/`.

### 1.4 Xác nhận: `BUG-AGENT-TASKV1-001` đồng ý — Engine 1 hôm nay "đồng bộ theo thiết kế"

`specs/agent/bugs/task-v1/BUG-AGENT-TASKV1-001-orcatask-run-agent-execprompt-verification.md`
dòng 209: *"Engine 1 (direct agent) coi là đồng bộ, không cần event — khớp
với `agent.execPrompt`'s bản chất unary/blocking."* Tài liệu này (audit
riêng, không phải tài liệu của agent audit trước — thư mục
`specs/agent/bugs/task-v1/` chỉ có 1 file, không có file
`BUG-AGENT-TASKV1-003` như một cross-ref trong đó kỳ vọng; phần streaming
được viết mới ở đây, dựa trên đọc code thật thay vì phụ thuộc file chưa tồn
tại) không mâu thuẫn với BUG-AGENT-TASKV1-001 — chỉ mở rộng câu hỏi "đồng bộ
có chấp nhận được mãi mãi không" thành 1 thiết kế cụ thể cho trường hợp cần
tiến độ giữa chừng (task chạy AI agent nhiều phút, ví dụ gần chạm
`MAX_TIMEOUT_MS = 15 phút`).

---

## 2. Thiết kế đề xuất (chỉ thiết kế — không code hoàn chỉnh)

### 2.1 `agent/` — notification mới `agent.execOutput`, tái dùng nguyên xi cơ chế `makeNotifier`

```typescript
// agent/src/relay/agent-print-mode-exec.ts (sửa handleAgentExecPrompt's signature)
export async function handleAgentExecPrompt(
  id: string | number | null,
  params: Record<string, unknown>,
  config: AgentConfig,
  log: AgentLogger,
  notify?: (method: string, params: Record<string, unknown>) => void   // MỚI — optional, giữ backward-compat cho mọi caller cũ
): Promise<object> {
  ...
  child.stdout?.on('data', (d: Buffer) => {
    const chunk = d.toString('utf8')
    stdout += chunk
    notify?.('agent.execOutput', { stepId, stream: 'stdout', chunk })
  })
  child.stderr?.on('data', (d: Buffer) => {
    const chunk = d.toString('utf8')
    stderr += chunk
    notify?.('agent.execOutput', { stepId, stream: 'stderr', chunk })
  })
  ...
}
```

```typescript
// agent/src/relay/agent-rpc-dispatch-agent-exec.ts — case 'agent.execPrompt', thêm makeNotifier
case 'agent.execPrompt': {
  const { handleAgentExecPrompt } = await import('./agent-print-mode-exec')
  return (await handleAgentExecPrompt(
    rpc.id, rpc.params ?? {}, config, log,
    makeNotifier(ws, state)   // MỚI — cùng pattern pty.create/pty.attach đã dùng
  )) as JsonRpcResponse
}
```

Response cuối (`{stdout, stderr, exitCode, timedOut, stepId}`) **giữ
nguyên** — không đổi shape, không phá caller cũ (`SimpleExecutor`,
`StepExecutors.executeAgent()`, `ProfileAwareAgentSpawner.spawn()`) vốn chỉ
đọc response, bỏ qua mọi notification không quen biết. Đây là điểm thiết kế
cố ý: **thêm khả năng, không thay thế hợp đồng cũ** — giống cách
`BUG-AG-ORCH-006`'s fix (`agent.spawn`'s `agent.output`/`agent.exited`) đã
làm cho `agent.spawn`.

Vấn đề chưa quyết định (để lại cho session triển khai sau): gửi
`agent.execOutput` theo **từng `data` event thô** (có thể rất nhỏ/rất dày
tần suất — `child.stdout` không gom batch) hay theo **line-buffer** (gom tới
`\n` mới gửi, giống cách `pty.data` Part B có batching 8ms — xem
`agent-rpc-catalog-runtime.md` dòng 290-293) để tránh flood WS frame cho
output verbose. Không có tiền lệ chọn sẵn cho RPC này (khác `pty.data` đã có
batching, `agent.execPrompt` chưa từng stream gì).

### 2.2 `infra-fleet-service` — thêm demux thứ 3, theo đúng pattern `ptySubs`/`screencastSubs`

```go
// session.go — thêm cạnh ptySubs/screencastSubs (dòng ~77-95)
execOutputSubs map[string][]chan rawExecOutputNotification   // keyed by stepId

// routeNotification (dòng 319-328) — thêm nhánh thứ 3
case strings.HasPrefix(n.Method, "agent.execOutput"):
    s.routeExecOutputNotification(n)
```

```go
// client.go — StreamExecOutput, cùng shape StreamPty (dòng 323-333)
func (c *Client) StreamExecOutput(ctx context.Context, devServer domain.DevServer, stepID string) (<-chan usecase.ExecOutputEvent, func(), error) {
    // relay-ssh: xem §3 — quyết định mở hay giữ chặn giống StreamPty/StreamBrowser hôm nay
}
```

Đây là **đúng pattern đã tồn tại 2 lần** (`ptySubs` cho PTY, `screencastSubs`
cho browser screencast) — không phát minh cơ chế mới ở tầng
`infra-fleet-service`, chỉ thêm 1 bản sao thứ 3 keyed theo `stepId` thay vì
`ptyID`/`worktreeID`.

### 2.3 `task-service` — tiêu thụ stream, republish thành event rời rạc (KHÔNG phải raw byte tới frontend)

`SimpleExecutor.Execute` gọi `StreamExecOutput` song song với `Exec`
(giống cách `AttachPty`/`WaitTerminalSession` dùng `StreamPty` — xem
`client.go:320-322`'s ghi chú caller), rồi:

- **Không** publish mỗi chunk thành 1 event outbox riêng (sẽ làm ngập
  `orchestration.messages`/outbox — CR-FLOW-TASK-003 §"Rủi ro" đã nói rõ
  CR-003 chỉ hợp nhất **sự kiện rời rạc**, không phải luồng byte).
- **Nên** gom theo 1 trong 2 cách (quyết định khi triển khai, không chốt ở
  đây): (a) throttle theo thời gian (ví dụ mỗi 2s publish 1
  `orca.task.agent_output_partial` event mang toàn bộ buffer tích luỹ tới
  thời điểm đó), hoặc (b) chỉ publish khi có "milestone" phát hiện được từ
  output (ví dụ OSC 133 boundary nếu CLI phát ra — nhưng `--print` mode của
  `claude` không chạy trong PTY nên **không có OSC sequence** — điểm khác
  biệt quan trọng so với `agent.spawn`'s interactive PTY path).
- Payload cuối cùng đổ vào đúng `task.activity:{taskId}` (CR-003 §3's
  `TaskActivityFrame`) với `Engine: "direct_agent"`, `EventType:
  "agent_output_partial"` — tái dùng khung đã thiết kế, không tạo kênh WS
  riêng.

### 2.4 Vòng đời hoàn chỉnh

```
agent CLI (claude --print) stdout/stderr
  → handleAgentExecPrompt's child.stdout.on('data')  [agent/, §2.1 — MỚI]
  → makeNotifier(ws,state)('agent.execOutput', {stepId,stream,chunk})   [đã có sẵn cơ chế, chỉ nối dây]
  → agent-session.ts's ws.send(encodeDataFrame(...))  [KHÔNG đổi — cùng frame codec mọi response dùng]
  → infra-fleet-service session.go readLoop → routeNotification → execOutputSubs[stepId]  [MỚI, §2.2]
  → Client.StreamExecOutput(...)  [MỚI, §2.2]
  → task-service.SimpleExecutor tiêu thụ song song với Exec()  [MỚI, §2.3]
  → throttle/buffer → outbox → api-gateway task.activity:{taskId}  [tái dùng CR-FLOW-TASK-003's hạ tầng]
```

---

## 3. Ảnh hưởng tới 3 connection mode

Khác với nhận định trực giác "mỗi mode có khả năng push khác nhau" — đọc
code `infra-fleet-service/internal/adapter/devserveragent/client.go`'s
package doc comment (dòng 1-46) cho thấy **cả 3 mode đã hội tụ về cùng 1
transport abstraction** ở tầng agent/infra-fleet-service (khác hẳn Node
backend's `relay-ssh`, vốn dùng hẳn 1 protocol/binary khác — `relay.js`/
Stack B — xem `specs/agent/api/connection-modes.md` §3):

| Mode | Agent-side code path | Đã hỗ trợ `makeNotifier`? |
|---|---|---|
| `direct-websocket` | `agent-connection-direct.ts` → `agent-session.ts` → `agent-rpc-dispatch.ts` (Part A) | Có — dùng chung `ws`/`WireState` mọi request |
| `relay-websocket` | `agent-connection-relay.ts` → cùng `agent-session.ts`/`agent-rpc-dispatch.ts` | Có — y hệt direct-websocket, chỉ khác ai dial ai |
| `relay-ssh` (backend-go) | `agent-connection-stdio.ts` (agent.js `--stdio`, SFTP-deploy qua SSH) → **cùng** `agent-session.ts`/`agent-rpc-dispatch.ts` (duck-typed stdio thay cho `ws` thật, comment dòng 109-110 của `agent-connection-stdio.ts`) | Có, về mặt lý thuyết — cùng code path Part A |

Tức là ở tầng **agent/**, không mode nào dễ/khó hơn mode nào — cả 3 đều
chạy qua đúng 1 `dispatch()`/`makeNotifier()`. Sự khác biệt thật nằm ở tầng
**infra-fleet-service**, không phải agent/:

- `Client.StreamPty`/`StreamBrowser` (tiền lệ demux gần nhất) **chặn cứng**
  `relay-ssh` ngay từ đầu hàm (`client.go:324-326`, `369-371`): *"relay-ssh
  mode has no pty.* JSON-RPC surface (no relay.js deployed)"*. Đọc kỹ hơn:
  lý do này có vẻ **không khớp thực tế** — package doc comment (dòng 21-29)
  xác nhận relay-ssh **cũng** deploy `agent.js --stdio` (đúng Part A, có
  đầy đủ `pty.*`/`makeNotifier`, không phải `relay.js`/Stack B như comment
  ngụ ý), và `getOrProvisionSession` (dòng 187-214) **có** tái sử dụng
  `c.sessions[devServer.ID]` giống 2 mode kia (dòng 204-209) — nghĩa là
  relay-ssh **cũng có session sống, lâu dài**, mâu thuẫn với "no persistent
  session" mà `StreamPty`'s doc comment (dòng 316) khẳng định.
- **Đây là một điểm cần xác minh lại, không phải điều audit này tự sửa** —
  nếu comment đó đúng ở 1 lý do khác chưa đọc ra (ví dụ:
  `managedExternally=true`, dòng 207/230, khiến session không tự
  reconnect/không đủ ổn định cho 1 subscription dài hạn như streaming, khác
  với 1 request/response ngắn của `Exec`), thì `StreamExecOutput` (§2.2) nên
  **kế thừa đúng giới hạn đó** cho tới khi lý do được làm rõ, thay vì tự ý
  mở rộng ra `relay-ssh` mà không kiểm chứng.
- Kết luận thực dụng: `StreamExecOutput` nên **khởi đầu chỉ hỗ trợ
  `direct-websocket`/`relay-websocket`** (2 mode `StreamPty` đã chứng minh
  hoạt động), và trả lỗi rõ ràng cho `relay-ssh` — giống hệt cách `StreamPty`
  làm hôm nay — cho tới khi ai đó xác minh lại vì sao `StreamPty` chặn
  `relay-ssh` và quyết định gỡ chặn đó cho cả 2 API cùng lúc.

**Update 2026-09-08 (BACKLOG-019, đã xác minh):** Mâu thuẫn đã được truy tới
tận gốc — `StreamPty`'s comment cũ ("no persistent session ... no relay.js
deployed") đơn giản là **sai**, không phải một lý do thiết kế khác chưa đọc
ra. `managedExternally=true` (giả thuyết còn để mở ở trên) chỉ đánh dấu
session không tự redial khi rớt — không liên quan gì tới việc subscription
dài hạn có hoạt động hay không một khi session đang sống. Không tìm thấy lý
do kỹ thuật nào khiến relay-ssh không hỗ trợ được `pty.*`/notification dài
hạn; kiến trúc (agent-session.ts/dispatcher.ts dùng chung, `*session` dùng
chung) nói ngược lại comment cũ. Đã sửa comment trong `client.go` để không
còn khẳng định sai sự thật (xem `StreamPty`'s doc comment mới), NHƯNG hành
vi runtime (chặn `relay-ssh`) **giữ nguyên** — chưa ai kiểm chứng
`pty.data`/`pty.exit` notification thật sự đến nơi qua duck-typed stdio
transport trên 1 dev server SSH-relay thật, và đó là thay đổi hành vi thật
sự (không phải sửa doc) nên cần test trước khi gỡ. Do đó câu hỏi mở #3 ở
mục 5 dưới đây **vẫn mở** — `StreamExecOutput` khi triển khai vẫn nên kế
thừa đúng gate hiện tại của `StreamPty`, đồng bộ 2 API, cho tới khi ai đó
verify end-to-end trên relay-ssh thật và gỡ chặn cho cả hai cùng lúc.

---

## 4. Vì sao dừng ở design-only

- **Cross-repo thật sự**: đổi cả `agent/` (2.1), `infra-fleet-service` (2.2,
  Go — khác ngôn ngữ, khác test suite), `task-service` (2.3), và gián tiếp
  `api-gateway`'s outbox consumer (CR-FLOW-TASK-003's kênh `task.activity`
  phải tồn tại trước — CR-003 hôm nay còn 🔵 Proposed, chưa triển khai).
  Không thể verify end-to-end nếu chỉ sửa 1 phía.
- **Connection đang mang production traffic thật**: `ws`/`WireState` mà
  `makeNotifier` dùng là **connection duy nhất** mọi PTY interactive
  (`pty.data`, `agent.spawn`'s `agent.output`) đang chạy — thêm 1 loại
  notification tần suất cao (`agent.execOutput`, có thể dày hơn `pty.data`
  nếu không line-buffer, xem §2.1's câu hỏi mở) vào cùng kết nối có rủi ro
  head-of-line-blocking nếu không đo đạc trước (Part B's `notifyBulk` đã
  giải quyết vấn đề tương tự cho git-diff chunks — Part A **chưa có** cơ chế
  flow-control tương đương, xem `specs/agent/api/connection-modes.md` §6's
  ghi chú `notifyBulk`).
- **Phụ thuộc CR-FLOW-TASK-001/003 đi trước**: không có `execution_links`
  (CR-001) thì không có chỗ mirror `status_mirror` cho lần chạy Engine 1;
  không có kênh `task.activity:{taskId}` (CR-003) thì §2.3 không có nơi đổ
  event tới — implement §2 trước 2 CR đó là xây ống dẫn không có điểm đến.
- ~~§3's mâu thuẫn comment trong `infra-fleet-service` cần người có bối
  cảnh TASK-192 xác nhận lại~~ — **Đã xác minh (BACKLOG-019, 2026-09-08):**
  comment cũ sai, đã sửa; `relay-ssh` có nằm trong scope đầu tiên hay không
  vẫn tuỳ vào việc có ai test streaming thật trên relay-ssh trước khi
  implement §2.2 hay không (xem update trong §3).

---

## 5. Câu hỏi mở phải trả lời trước khi implement

1. **Granularity**: raw `data` event hay line-buffered? (§2.1) — ảnh hưởng
   trực tiếp tần suất WS frame trên connection dùng chung với PTY.
2. **Cap kích thước**: `agent.execPrompt` hôm nay **không cap** stdout/
   stderr tích luỹ (khác `agent.execNonInteractive`'s 4MB/stream) — thêm
   streaming không tự động thêm cap; cần quyết định cap cho cả buffer tích
   luỹ (response cuối) lẫn từng chunk notification.
3. **`relay-ssh` có nằm trong scope đầu tiên không** — phụ thuộc việc xác
   minh mâu thuẫn ở §3.
4. **Giới hạn model `claude`-only** (`agent-print-mode-exec.ts:82-94`) nghĩa
   là thiết kế này **chỉ** áp dụng cho Task pin model `claude` qua Engine 1
   — task dùng `gemini`/`codex`/`opencode` qua `agent.execPrompt` đã fail
   `InvalidParams` từ trước (không phải gap streaming gây ra, nhưng giới hạn
   phạm vi thực tế của thiết kế này).
5. **Throttle policy cho task-service's outbox publish** (§2.3) — thời gian
   cố định hay milestone-based — cần dữ liệu thực tế về độ dài output trung
   bình của 1 lần `agent.execPrompt` trước khi chọn.

## Checklist

- [x] Xác nhận `agent.execPrompt` là unary end-to-end bằng code thật
      (`agent-print-mode-exec.ts`), không suy đoán.
- [x] Xác nhận cơ chế notification (`makeNotifier`) đã tồn tại và dùng được
      ngay — không cần đổi wire protocol.
- [x] Xác nhận điểm chặn thứ 2 (`infra-fleet-service`'s `routeNotification`
      chỉ nhận 2 họ method cứng) bằng code thật — không chỉ dừng ở "SOL-TG-04
      đã nói vậy".
- [x] Xác nhận cả 3 connection mode dùng chung 1 code path ở agent/ (khác
      Node backend's kiến trúc relay-ssh) — không lặp lại giả định sai từ
      `specs/agent/tdd/v5/03-connection-modes.md` (tài liệu đó không mô tả
      `agent-connection-stdio.ts`, vì file này chỉ tồn tại cho backend-go).
- [x] Phát hiện và ghi lại mâu thuẫn trong `client.go`'s `StreamPty` doc
      comment (§3) — không tự sửa, để lại cho phiên triển khai xác minh.
- [ ] Wire shape cho `agent.execOutput` — chưa chốt granularity (câu hỏi mở
      §5.1).
- [ ] Bất kỳ code nào — CHƯA viết.
