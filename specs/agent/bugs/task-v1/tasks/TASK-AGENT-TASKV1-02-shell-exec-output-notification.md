# TASK-AGENT-TASKV1-02: Thêm notification `shell.exec.output` cho `handleShellExec`

**Task ID:** TASK-AGENT-TASKV1-02
**Priority:** 🟠 P1 (giải quyết 1/2 gap thật của BUG-AGENT-TASKV1-003)
**Bugs fixed:** [BUG-AGENT-TASKV1-003](../BUG-AGENT-TASKV1-003-streaming-output-gap-for-activity-feed.md)
**Solution:** [SOL-AGENT-TASKV1-003](../solutions/SOL-AGENT-TASKV1-003-streaming-output-gap-for-activity-feed.md) §3 ("Pattern A")
**Estimated effort:** Nhỏ–Trung bình (giống TASK-AGENT-TASKV1-01, cộng thêm
phải luồn `WireState` qua 1 lớp dispatch chưa có sẵn tham số này)
**Dependencies:** Không bắt buộc — độc lập với TASK-AGENT-TASKV1-01, có thể
làm song song (2 handler khác file, không đụng nhau)
**Status:** [ ] TODO

---

## Bối cảnh

`shell.exec` (RPC dùng cho Workflow `shell` step, gọi bởi
`StepExecutors.executeShell()`) spawn `sh -c <script>` và cũng buffer toàn bộ
`stdout`/`stderr` cho tới `child.on('close', ...)` rồi trả 1 response duy
nhất (`agent/src/relay/fs-agent-extensions.ts:541-595`, xem đặc biệt dòng
561-594: `Promise` bọc quanh `spawn`, `resolve()` gọi đúng 1 lần). Cùng vấn đề
như `agent.execPrompt` (TASK-AGENT-TASKV1-01) — không có tiến độ giữa chừng
cho Activity Feed.

Áp dụng đúng Pattern A đã chọn trong solution (giống hệt
TASK-AGENT-TASKV1-01) — dùng `makeNotifier(ws, state)`
(`agent/src/relay/agent-rpc-dispatch.ts:275-285`), **không** dùng Pattern B
(`git.execStream`'s same-id multi-frame). Khác biệt so với
`agent.execPrompt`: `shell.exec` không có `stepId` trong params — dùng
`traceId` (đã có sẵn, optional, `fs-agent-extensions.ts:547`,
`params: { script, env, traceId?, timeoutMs? }`) làm khoá định danh chunk,
đúng đề xuất của solution.

**Khác biệt quan trọng so với TASK-AGENT-TASKV1-01 — cần luồn thêm
`WireState`:** `handleAgentExecPrompt` nằm trong `dispatchAgentExecRpc`, vốn
đã nhận cả `ws`/`state`. Nhưng `handleShellExec` nằm trong `dispatchMiscRpc`
(`agent/src/relay/agent-rpc-dispatch-misc.ts:15-21`), **hiện chỉ nhận `ws`,
không nhận `state: WireState`** — mà `makeNotifier` bắt buộc cần cả hai để
gọi `encodeDataFrame(state, ...)`. Do đó task này khác solution ở 1 điểm kỹ
thuật (solution nói "không cần `state`" — xác nhận đọc code thật thì **cần**,
vì không có cách nào build 1 JSON-RPC frame hợp lệ mà thiếu `WireState`):
phải thêm tham số `state` vào `dispatchMiscRpc` và cập nhật đúng 1 call site
gọi nó.

**Files cần sửa:**
1. `agent/src/relay/agent-rpc-dispatch.ts` — truyền `state` vào lời gọi
   `dispatchMiscRpc(...)` đã có.
2. `agent/src/relay/agent-rpc-dispatch-misc.ts` — thêm tham số `state` vào
   signature `dispatchMiscRpc`, build `notify` tại `case 'shell.exec'`.
3. `agent/src/relay/fs-agent-extensions.ts` — thêm tham số `notify` cho
   `handleShellExec`, gọi trong 2 handler `data`.
4. Test mới cho `handleShellExec` (chưa có file test riêng — xem mục Unit
   Tests).

---

## Implementation

### Part 1: `agent/src/relay/agent-rpc-dispatch.ts`

Đổi call site hiện có (dòng 345) từ:

```typescript
  const fromMisc = await dispatchMiscRpc(rpc, tools, config, log, ws)
```

thành:

```typescript
  const fromMisc = await dispatchMiscRpc(rpc, tools, config, log, ws, state)
```

(`state` đã có sẵn trong scope của `route()` — là tham số thứ 6 của chính
hàm `route`, dòng 292-299 — không cần lấy từ đâu khác.)

### Part 2: `agent/src/relay/agent-rpc-dispatch-misc.ts`

Thêm import `WireState` + `makeNotifier`:

```typescript
import type { WireState } from 'orca-dev-agent-transport'
import { makeError, formatMcpResult, makeNotifier } from './agent-rpc-dispatch'
```

Sửa signature `dispatchMiscRpc` (dòng 15-21):

```typescript
export async function dispatchMiscRpc(
  rpc: JsonRpcRequest,
  tools: ToolDefinition[],
  config: AgentConfig,
  log: AgentLogger,
  ws: WebSocket,
  state: WireState // MỚI
): Promise<JsonRpcResponse | null> {
```

Sửa `case 'shell.exec'` (dòng 263-270 hiện tại):

```typescript
    case 'shell.exec': {
      try {
        const { handleShellExec } = await import('./fs-agent-extensions')
        const notify = makeNotifier(ws, state)
        return (await handleShellExec(rpc.id, rpc.params ?? {}, config, notify)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `shell.exec unavailable: ${msg}`)
      }
    }
```

### Part 3: `agent/src/relay/fs-agent-extensions.ts`

Thêm tham số thứ 4, optional, cho `handleShellExec` (dòng 541-545 hiện tại):

```typescript
export async function handleShellExec(
  id: string | number | null,
  params: Record<string, unknown>,
  _config: AgentConfig,
  notify?: (method: string, params: Record<string, unknown>) => void // MỚI
): Promise<object> {
```

Trong khối `child.stdout.on('data', ...)`/`child.stderr.on('data', ...)`
(dòng 573-580 hiện tại), phát notification **trước khi** áp dụng cap
`SHELL_EXEC_MAX_OUTPUT_BYTES` cho buffer lưu trữ (notify luôn nhận chunk gốc
đầy đủ — cap chỉ áp dụng cho response cuối, không phải Activity Feed):

```typescript
    child.stdout.on('data', (d: Buffer) => {
      const chunk = d.toString('utf8')
      if (stdout.length < SHELL_EXEC_MAX_OUTPUT_BYTES) {stdout += chunk}
      else {truncated = true}
      notify?.('shell.exec.output', { traceId, stream: 'stdout', data: chunk })
    })
    child.stderr.on('data', (d: Buffer) => {
      const chunk = d.toString('utf8')
      if (stderr.length < SHELL_EXEC_MAX_OUTPUT_BYTES) {stderr += chunk}
      else {truncated = true}
      notify?.('shell.exec.output', { traceId, stream: 'stderr', data: chunk })
    })
```

Không đổi phần timeout (dòng 567-571), `close`/`error` handler (dòng
581-594), hay response cuối.

---

## Wire Protocol

```jsonc
// Request (không đổi):
Backend → Agent: { "jsonrpc": "2.0", "id": 9, "method": "shell.exec",
                    "params": { "script": "npm test", "traceId": "trace-abc" } }

// MỚI — 0..n notification trong lúc script còn chạy, không có "id":
Agent → Backend: { "jsonrpc": "2.0", "method": "shell.exec.output",
                    "params": { "traceId": "trace-abc", "stream": "stdout", "data": "PASS src/foo.test.ts\n" } }

// Response cuối (không đổi shape, vẫn mang đúng "id": 9):
Agent → Backend: { "jsonrpc": "2.0", "id": 9,
                    "result": { "stdout": "...", "stderr": "...", "exitCode": 0 } }
```

Nếu `traceId` không được backend gửi (field optional), `params.traceId` sẽ
là `undefined` và bị `JSON.stringify` bỏ qua — backend nhận notification
không có khoá định danh, chấp nhận được vì đây là hành vi best-effort giống
hệt cách `stepId` optional được xử lý trong `agent.execPrompt.output`
(TASK-AGENT-TASKV1-01).

---

## Unit Tests to Add

`handleShellExec` hiện **chưa có file test riêng** (xác nhận: không có
`describe`/`it` nào cho `handleShellExec` trong
`agent/src/relay/__tests__/fs-agent-extensions.test.ts` tại thời điểm viết
task này). Thêm 1 `describe` mới vào đúng file đó:

```typescript
describe('handleShellExec', () => {
  it('emits shell.exec.output notifications for each stdout/stderr chunk', async () => {
    const notify = vi.fn()
    const promise = handleShellExec(
      1, { script: 'true', traceId: 'trace-abc' }, config, notify
    )
    const child = getLastSpawnedChild() // mock spawn('sh', ['-c', ...]) — theo pattern mock đã dùng cho các handler subprocess khác trong file này
    child.stdout.emit('data', Buffer.from('out-1'))
    child.stderr.emit('data', Buffer.from('err-1'))
    child.emit('close', 0)
    await promise

    expect(notify).toHaveBeenCalledWith('shell.exec.output', {
      traceId: 'trace-abc', stream: 'stdout', data: 'out-1'
    })
    expect(notify).toHaveBeenCalledWith('shell.exec.output', {
      traceId: 'trace-abc', stream: 'stderr', data: 'err-1'
    })
  })

  it('still resolves with the unchanged response shape when notify is omitted', async () => {
    const promise = handleShellExec(2, { script: 'true' }, config)
    const child = getLastSpawnedChild()
    child.emit('close', 0)
    const result = await promise as any
    expect(result.result.exitCode).toBe(0)
  })
})
```

Nếu file test chưa mock `child_process.spawn` theo kiểu tái sử dụng được
(`getLastSpawnedChild()` là tên gợi ý, không phải helper có sẵn), tạo 1 mock
`EventEmitter`-based `child` tối thiểu (`stdout`, `stderr` là `EventEmitter`,
bản thân `child` cũng là `EventEmitter` cho `close`), theo đúng cách
`agent-print-mode-exec.test.ts` đã làm cho `handleAgentExecPrompt` (xem
TASK-AGENT-TASKV1-01, dòng 110-131 của file đó) — dùng làm mẫu tham khảo
1:1.

File `agent/src/relay/agent-rpc-dispatch-misc.test.ts`: xác nhận file này
tồn tại nhưng hiện **không có test nào cho `case 'shell.exec'`** — nếu thêm
test dispatch-level, cần cập nhật mọi lời gọi `dispatchMiscRpc(...)` trong
file test này để truyền thêm tham số `state` (breaking signature change,
không phải thêm optional) — rà lại toàn bộ test hiện có trong file khi thực
hiện task này để tránh lỗi biên dịch TypeScript do thiếu tham số bắt buộc.

---

## Verification

```bash
cd agent
npx tsc --noEmit -p config/tsconfig.node.json 2>&1 | grep -E "agent-rpc-dispatch|fs-agent-extensions"
npx vitest run src/relay/agent-rpc-dispatch-misc.test.ts src/relay/__tests__/fs-agent-extensions.test.ts
```

Chạy riêng lệnh `tsc` sau khi đổi signature `dispatchMiscRpc` là bắt buộc —
đây là 1 thay đổi tham số **không optional**, mọi call site khác (kể cả
trong test file) phải được cập nhật, khác với TASK-AGENT-TASKV1-01 (chỉ
thêm tham số optional).

---

## Không thuộc phạm vi task này

- Hạ tầng backend-go nhận `shell.exec.output` — xem
  [SOL-AGENT-TASKV1-002](../solutions/SOL-AGENT-TASKV1-002-task-execute-worker-dispatch-primitives-unwired.md)'s
  Việc 1.
- `agent.execPrompt.output` — xem
  [TASK-AGENT-TASKV1-01](./TASK-AGENT-TASKV1-01-agent-execprompt-output-notification.md).
