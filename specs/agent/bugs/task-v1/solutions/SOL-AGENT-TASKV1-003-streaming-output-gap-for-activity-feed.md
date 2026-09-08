# SOL-AGENT-TASKV1-003: Thiết kế streaming notification cho `agent.execPrompt`/`shell.exec` — áp dụng đúng 2 pattern đã có (`pty.data` và `git.execStream`)

**Giải quyết:** [BUG-AGENT-TASKV1-003](../BUG-AGENT-TASKV1-003-streaming-output-gap-for-activity-feed.md)

## Gap này nằm ở đâu?

**📋 CÓ — đây LÀ gap thật ở `agent/`.** Khác với bug 001/002/004,
`agent.execPrompt` và `shell.exec` hôm nay buffer toàn bộ stdout/stderr rồi
trả 1 response duy nhất — không có bất kỳ RPC/notification nào ở
`backend-go` có thể gọi để nhận tiến độ giữa chừng, vì phía `agent/` chưa
phát ra tiến độ đó. Cần thêm code thật ở `agent/`.

Xác nhận bằng đọc trực tiếp 2 handler:

- `agent/src/relay/agent-print-mode-exec.ts:124-163` — `handleAgentExecPrompt`
  spawn `spec.binary` với `args=['--print', prompt, ...]`, gắn
  `child.stdout.on('data', d => stdout += ...)`/`child.stderr.on('data', ...)`
  chỉ để nối chuỗi, và chỉ `resolve()` một lần duy nhất tại `child.on('close', ...)`
  (dòng 160-162) hoặc timeout (dòng 141-149). Trả về đúng 1
  `{jsonrpc, id, result: {stdout, stderr, exitCode, timedOut, stepId}}`
  (dòng 177) sau khi process đã thoát hoàn toàn.
- `agent/src/relay/fs-agent-extensions.ts:541-595` — `handleShellExec` spawn
  `sh -c script`, cùng pattern: `child.stdout.on('data', ...)` chỉ nối
  chuỗi (dòng 573-580, có cap `SHELL_EXEC_MAX_OUTPUT_BYTES`), chỉ
  `resolve()` một lần tại `child.on('close', ...)` (dòng 581-588).

Cả hai được dispatch **await đồng bộ, chờ tới response cuối** — khác hẳn
`agent.spawn`/`git.execStream` (xem dưới).

## 2 pattern streaming đã có sẵn ở `agent/` — đọc thật để làm mẫu

### Pattern A — JSON-RPC notification thật (dùng cho `agent.spawn` → `agent.output`/`pty.create` → `pty.data`)

`agent/src/relay/agent-rpc-dispatch-agent-exec.ts:23-31`:
```typescript
case 'agent.spawn': {
  try {
    const { handleAgentSpawn } = await import('./agent-spawner')
    // Fire-and-forget: streaming handler sends multiple frames asynchronously
    void handleAgentSpawn(rpc.id, rpc.params ?? {}, config, log, ws, state)
    return { jsonrpc: '2.0', id: rpc.id, result: { type: 'spawn.accepted' } }
  } catch (err: unknown) { ... }
}
```
Dispatcher trả **ngay 1 response ack** (`{type:'spawn.accepted'}`), không
đợi handler xong. Handler (`agent-spawner.ts`) tự phát notification —
**không có `id`**, gửi bằng `sendAgentSpawnNotification` (định nghĩa
`agent-spawner.ts:138-145`, gọi `dispatcher.notify(method, params)` — thấy
rõ ở `dispatcher.ts:202-212`: `notify()` build
`{jsonrpc:'2.0', method, ...(params...)}` — **không set `id`**, đúng chuẩn
JSON-RPC notification, tránh đúng lỗi BUG-AG-ORCH-006 từng mắc (gửi output
như response). `pty-agent-bridge.ts:245-248` dùng cùng cơ chế cho `pty.data`
qua `entry.notify('pty.data', {id: ptyId, data})`.

**Đặc điểm:** 1 request ban đầu (có `id`) → nhiều notification độc lập
(không `id`, định danh bằng `ptyId`/`id` trong `params`) → không có "kết
thúc" tường minh trên cùng kênh notify (kết thúc = 1 notification riêng,
`agent.exited`/`pty.exit`).

### Pattern B — same-id multi-frame "streamed response" (dùng cho `git.execStream`)

`agent/src/relay/agent-rpc-dispatch-git.ts:35-44`:
```typescript
case 'git.execStream': {
  try {
    const { handleGitExecStream } = await import('./agent-git-handler')
    // Streaming: fire-and-forget, sends multiple frames asynchronously
    void handleGitExecStream(ws, state, rpc.id, rpc.params ?? {}, config, log)
    return { jsonrpc: '2.0', id: rpc.id, result: { type: 'stream.started' } }
  } catch (err: unknown) { ... }
}
```
`agent/src/relay/agent-git-handler.ts:280-314` (`sendChunk`/`sendEnd`, dùng
trong `child.stdout.on('data', ...)`/`child.stderr.on('data', ...)`/
`child.on('close', ...)`):
```typescript
function sendChunk(line: string, source?: 'stderr'): void {
  sendFrame(ws, wireState, {
    jsonrpc: '2.0', id,
    result: { type: 'stream.chunk', line, ...(source ? { source } : {}) }
  })
}
function sendEnd(exitCode: number): void {
  sendFrame(ws, wireState, { jsonrpc: '2.0', id, result: { type: 'stream.end', exitCode } })
}
```
**Đặc điểm khác Pattern A:** mỗi frame vẫn mang **cùng `id`** của request gốc
(không phải notification thuần — vẫn có `id`, phân biệt bằng field
`result.type`: `'stream.started'` → nhiều `'stream.chunk'` → 1
`'stream.end'`). `sendFrame` (định nghĩa dòng 329-333) cần cả `ws` **và**
`wireState` để encode đúng frame (không chỉ `ws.send` trực tiếp).

## Đề xuất: dùng Pattern A (notification, giống `pty.data`) cho cả 2 RPC — không dùng Pattern B

Lý do chọn Pattern A thay vì B:

1. **Nhất quán với 3 hệ Task khác:** BUG-AGENT-TASKV1-002 xác nhận
   `agent.output`/`agent.exited` (Pattern A) là hướng backend-go đã bắt đầu
   thiết kế nhận (`SOL-AG-01`'s `StreamPty` reuse). Dùng cùng 1 pattern cho
   `agent.execPrompt`/`shell.exec` giúp backend-go xây **1** usecase nhận
   notification-theo-id (`ptyId`/`stepId`) thay vì phải xử lý 2 pattern wire
   khác nhau.
2. `stepId` đã có sẵn trong params của cả 2 RPC (`agent.execPrompt` nhận
   `params.stepId` — `agent-print-mode-exec.ts:41`; `shell.exec` chưa có
   nhưng dễ thêm) — dùng làm khoá định danh chunk, giống `ptyId` của Pattern
   A, tự nhiên hơn so với việc phải giữ đúng `id` gốc xuyên suốt như Pattern
   B (Pattern B hợp với `git.execStream` vì đó vốn thiết kế cho 1 request UI
   trực tiếp chờ kết quả — Task Activity Feed cần định danh theo `stepId`
   nghiệp vụ, không phải theo request `id` giao thức).
3. Outbox/notification design của CR-FLOW-TASK-003 (mô tả trong bug gốc)
   vốn đã là kiểu "sự kiện rời rạc theo `taskId`/`stepId`" — khớp tự nhiên
   với Pattern A.

## Thiết kế cụ thể

### 1. Notification mới: `agent.execPrompt.output` / `shell.exec.output`

Tên method tách riêng cho từng RPC (không dùng chung 1 tên) — tránh backend
phải phân biệt nguồn gốc chunk bằng cách đoán field, và giữ đúng convention
hiện có (`agent.output` cho `agent.spawn`, `pty.data` cho `pty.create` — mỗi
RPC nguồn có method notify riêng).

```jsonc
// agent.execPrompt.output — 1 notification / lần child.stdout|stderr 'data'
{ "jsonrpc": "2.0", "method": "agent.execPrompt.output",
  "params": { "stepId": "...", "stream": "stdout" | "stderr", "data": "..." } }

// shell.exec.output — tương tự, khoá theo 1 id mới (xem mục 3, shell.exec
// hôm nay không có stepId trong params — cần thêm hoặc dùng `traceId` đã có)
{ "jsonrpc": "2.0", "method": "shell.exec.output",
  "params": { "traceId": "...", "stream": "stdout" | "stderr", "data": "..." } }
```

Không cần base64: khác `pty.data`/`agent.output` (terminal binary-safe),
stdout của `--print`/`sh -c` là text — giữ nguyên UTF-8 string, đơn giản hơn
cho backend parse trực tiếp vào Activity Feed message.

### 2. `handleAgentExecPrompt` — thêm callback stream, giữ nguyên response cuối

```typescript
// agent-print-mode-exec.ts
export async function handleAgentExecPrompt(
  id: string | number | null,
  params: Record<string, unknown>,
  config: AgentConfig,
  log: AgentLogger,
  notify?: (method: string, params: Record<string, unknown>) => void // MỚI, optional để không phá vỡ caller cũ/test hiện có
): Promise<object> {
  // ... giữ nguyên phần validate/resolveAgentSpec/buildAgentEnv ...

  child.stdout?.on('data', (d: Buffer) => {
    const chunk = d.toString('utf8')
    stdout += chunk
    notify?.('agent.execPrompt.output', { stepId, stream: 'stdout', data: chunk })
  })
  child.stderr?.on('data', (d: Buffer) => {
    const chunk = d.toString('utf8')
    stderr += chunk
    notify?.('agent.execPrompt.output', { stepId, stream: 'stderr', data: chunk })
  })
  // child.on('close', ...) / finish(...) giữ nguyên — response cuối cùng
  // KHÔNG đổi shape, đúng yêu cầu "không phá vỡ contract hiện có" (caller
  // hôm nay là task-service.SimpleExecutor, chỉ đọc response cuối, vẫn hoạt
  // động y nguyên nếu bỏ qua notification).
}
```

Dispatch site (`agent-rpc-dispatch-agent-exec.ts:176-188`) cần đổi từ
`await` đồng bộ sang truyền `notify` — 2 lựa chọn:

- **(a) Giữ awaited (khuyến nghị):** vẫn `await handleAgentExecPrompt(...)`
  như hôm nay (dispatch site không đổi behavior chờ-response), chỉ truyền
  thêm tham số `notify` để handler phát chunk **song song** trong lúc đang
  chạy — dispatcher không cần đổi từ "unary" sang "fire-and-forget", vì
  response cuối vẫn cần trả đúng khi `SimpleExecutor` gọi (nó là 1 unary RPC
  qua `infra-fleet-service.Relay`, không có khái niệm "ack rồi chờ notify"
  như `agent.spawn`). `notify` lấy từ `dispatcher.notify` binding có sẵn
  trên connection (cùng instance `sendAgentSpawnNotification`/
  `entry.notify` dùng) — không cần đổi signature `ws`/`state`, tái dùng
  đúng `dispatcher.notify` (`dispatcher.ts:202`) đã sẵn có trên mọi
  connection.
- (b) Đổi sang fire-and-forget kiểu Pattern A đầy đủ (ack ngay
  `{type:'execPrompt.accepted'}`, response cuối cũng là 1 notification
  `agent.execPrompt.exited`) — **không khuyến nghị** cho `agent.execPrompt`
  vì phá vỡ contract unary mà `SimpleExecutor` đang dựa vào (nó `await`
  `Relay()` để lấy `stdout`/`exitCode` ngay trong cùng 1 lời gọi — đổi sang
  (b) buộc backend-go phải làm lại toàn bộ luồng nhận, không chỉ thêm nhận
  notification). **Lựa chọn (a) là non-breaking, nên ưu tiên.**

### 3. `handleShellExec` — cùng pattern, cần thêm 1 field định danh

`shell.exec`'s params hôm nay chỉ có `{script, env, traceId?, timeoutMs?}`
(`fs-agent-extensions.ts:546-553`) — có `traceId` optional, đủ dùng làm khoá
notify nếu caller (`workflow-service.shell_step_executor.go`) gửi. Áp dụng
y hệt mục 2: thêm tham số `notify?`, gọi trong `child.stdout.on('data', ...)`/
`child.stderr.on('data', ...)` (dòng 573-580), giữ nguyên response cuối
(dòng 581-594). Dispatch site `agent-rpc-dispatch-misc.ts:248-254` hiện chỉ
nhận `ws` (không có `state`) — cần truyền thêm `dispatcher.notify` binding
tương tự (không cần `state`/`sendFrame`, vì Pattern A dùng `dispatcher.notify`
chứ không dùng `sendFrame`+`wireState`).

### 4. Không đổi `ai.complete` trong solution này

`ai.complete` (OrcaTask AI-decompose) là 1 lời gọi LLM hoàn chỉnh (không
phải subprocess có stdout tăng dần) — áp dụng "chunk theo token" đòi hỏi
tích hợp streaming API của provider (khác hẳn cơ chế `child.stdout.on`)
— nằm ngoài phạm vi bug này (bug 003 chỉ liệt kê `agent.execPrompt`/
`shell.exec` là 2 RPC dùng subprocess buffer). Nếu cần, nên là 1 CR riêng.

## Việc còn lại ở backend-go — solution này KHÔNG giải quyết (đã ghi rõ trong bug gốc)

Thêm notification ở `agent/` chỉ giải quyết được **một nửa**: nửa còn lại là
`infra-fleet-service.Relay` (unary) không có cơ chế nhận notification giữa
lúc 1 `Relay()` call còn đang treo. Đây chính là Gap 2 của
[BUG-AGENT-TASKV1-002](../BUG-AGENT-TASKV1-002-task-execute-worker-dispatch-primitives-unwired.md)
— cùng nút thắt hạ tầng, cần cùng 1 giải pháp streaming RPC/kênh nhận (xem
[SOL-AGENT-TASKV1-002](./SOL-AGENT-TASKV1-002-task-execute-worker-dispatch-primitives-unwired.md)'s
Việc 1). Thứ tự khuyến nghị (giữ nguyên theo SOL-AG-PW-001 §3):

1. Sửa `workflow-service.AgentExecutor` dùng đúng `agent.execPrompt`
   ([BUG-AGENT-TASKV1-004](../BUG-AGENT-TASKV1-004-workflow-service-agent-step-executor-still-broken.md)
   — đã có thiết kế `SOL-PRF-04`/`TASK-PRF-04-06`, xem
   [SOL-AGENT-TASKV1-004](./SOL-AGENT-TASKV1-004-workflow-service-agent-step-executor-still-broken.md)).
2. `infra-fleet-service` mở kênh nhận notification qua `AttachPty` đã có
   (dùng chung thiết kế `SOL-AG-01`, xem `SOL-AGENT-TASKV1-002` Việc 1).
3. **agent/ (solution này):** thêm `notify` callback trong
   `handleAgentExecPrompt`/`handleShellExec`.
4. Backend-go nối `agent.execPrompt.output`/`shell.exec.output` vào outbox
   của CR-FLOW-TASK-003 (hoặc kênh phụ riêng nếu tần suất chunk quá cao cho
   outbox pattern).

## Test plan (cho phần thuộc `agent/`)

- `agent-print-mode-exec.test.ts`: thêm case gọi `handleAgentExecPrompt` với
  `notify` mock — assert `notify` được gọi ≥1 lần với
  `method === 'agent.execPrompt.output'` và `params.stepId` đúng, **và**
  response cuối cùng (return value) không đổi shape so với test hiện có khi
  `notify` là `undefined` (backward-compat).
- `fs-agent-extensions.test.ts` (hoặc file test tương ứng `handleShellExec`):
  tương tự, assert `shell.exec.output` chunk + response cuối không đổi.
- Không cần test tích hợp `ws`/`dispatcher` mới nếu dùng lựa chọn (a) —
  `dispatcher.notify` đã có test coverage riêng (`dispatcher.test.ts`).

## Kết luận / Status

**📋 Proposed — chưa triển khai.** Đây là gap thật ở `agent/`, cần code mới:
thêm tham số `notify` + 2 notification method mới
(`agent.execPrompt.output`, `shell.exec.output`) vào 2 handler hiện có,
theo đúng Pattern A (`pty.data`/`agent.output`) đã chứng minh chạy production.
Giá trị thực tế của thay đổi này phụ thuộc vào việc backend-go triển khai
song song hạ tầng nhận (Việc 1 của `SOL-AGENT-TASKV1-002`) — nên coi 2 việc
này là 1 cặp, không tách rời khi lên kế hoạch triển khai.

## Tham khảo

- [`specs/agent/crs/v3/project-workspace/solutions/SOL-AG-PW-001-execution-progress-reporting-design.md`](../../../crs/v3/project-workspace/solutions/SOL-AG-PW-001-execution-progress-reporting-design.md)
- [`specs/agent/bugs/agent-orchestration/BUG-AG-ORCH-006-agent-output-stream-handler-missing.md`](../../agent-orchestration/BUG-AG-ORCH-006-agent-output-stream-handler-missing.md)
- [SOL-AGENT-TASKV1-002](./SOL-AGENT-TASKV1-002-task-execute-worker-dispatch-primitives-unwired.md) — hạ tầng nhận notification ở backend-go cần song song.
- [SOL-AGENT-TASKV1-004](./SOL-AGENT-TASKV1-004-workflow-service-agent-step-executor-still-broken.md) — prerequisite bắt buộc trước bước 2.

## Trích dẫn file:line (đọc trực tiếp, 2026-09-08)

- `agent/src/relay/agent-print-mode-exec.ts:33-46,124-163,177` — `handleAgentExecPrompt`, buffer-only stdout/stderr, response cuối.
- `agent/src/relay/fs-agent-extensions.ts:541-595` — `handleShellExec`, buffer-only, cap `SHELL_EXEC_MAX_OUTPUT_BYTES`.
- `agent/src/relay/agent-rpc-dispatch-agent-exec.ts:23-31,176-188` — dispatch `agent.spawn` (Pattern A, fire-and-forget) vs `agent.execPrompt` (unary, awaited).
- `agent/src/relay/agent-rpc-dispatch-misc.ts:15-21,244-254` — `dispatchMiscRpc` signature (chỉ nhận `ws`, không `state`), case `shell.exec`.
- `agent/src/relay/agent-spawner.ts:138-145,604,621` — `sendAgentSpawnNotification`, Pattern A's emit thật.
- `agent/src/relay/pty-agent-bridge.ts:245-253` — `entry.notify('pty.data', ...)`, Pattern A áp dụng cho PTY thường.
- `agent/src/relay/dispatcher.ts:202-212` — `notify()`, JSON-RPC notification builder dùng chung (không set `id`).
- `agent/src/relay/agent-rpc-dispatch-git.ts:35-44` — dispatch `git.execStream` (Pattern B).
- `agent/src/relay/agent-git-handler.ts:232-243,280-314,329-333` — `handleGitExecStream`, `sendChunk`/`sendEnd`, `sendFrame` (Pattern B, cần cả `ws` + `wireState`).
