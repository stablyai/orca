# TASK-AGENT-TASKV1-01: Thêm notification `agent.execPrompt.output` cho `handleAgentExecPrompt`

**Task ID:** TASK-AGENT-TASKV1-01
**Priority:** 🟠 P1 (giải quyết 1/2 gap thật của BUG-AGENT-TASKV1-003)
**Bugs fixed:** [BUG-AGENT-TASKV1-003](../BUG-AGENT-TASKV1-003-streaming-output-gap-for-activity-feed.md)
**Solution:** [SOL-AGENT-TASKV1-003](../solutions/SOL-AGENT-TASKV1-003-streaming-output-gap-for-activity-feed.md) §2 ("Pattern A")
**Estimated effort:** Nhỏ (1 tham số mới + 2 lệnh gọi `notify` + wiring dispatch)
**Dependencies:** Không — độc lập với TASK-AGENT-TASKV1-02
**Status:** [ ] TODO

---

## Bối cảnh

`agent.execPrompt` (RPC dùng cho OrcaTask Run-Agent và Workflow `agent` step,
xem BUG-AGENT-TASKV1-001/004) spawn `claude --print <prompt>` và chỉ nối
chuỗi `stdout`/`stderr` cho tới khi process thoát, rồi trả **đúng 1** response
JSON-RPC. Không có cách nào cho backend-go quan sát tiến độ giữa chừng —
Activity Feed (CR-FLOW-TASK-003) không có gì để hiển thị cho tới khi cả bước
`agent` chạy xong (có thể tới `MAX_TIMEOUT_MS = 15 * 60_000`).

`agent/` đã có sẵn đúng pattern cần dùng (JSON-RPC notification, không có
`id`, định danh bằng field trong `params`) — dùng cho `agent.spawn` →
`agent.output`/`agent.exited` (`agent-spawner.ts:138-145,604,621`) và
`pty.create` → `pty.data` (`pty-agent-bridge.ts:245-253`). Quan trọng hơn:
**đã có sẵn 1 helper dùng chung cho đúng việc này** —
`makeNotifier(ws, state)` tại `agent/src/relay/agent-rpc-dispatch.ts:275-285`
— build 1 hàm `(method, params) => void` gửi notification qua đúng
connection hiện tại, dùng lại y hệt frame codec của response
(`encodeDataFrame`). `git`/`fs`/`pty`/`browser` dispatch file đều đã dùng
helper này cho notifier của riêng mình (xem comment dòng 272-273 của chính
`makeNotifier`) — task này chỉ áp dụng đúng convention đã có, không phát
minh cơ chế mới.

*(Lưu ý sửa 1 chi tiết nhỏ trong solution: SOL-AGENT-TASKV1-003 gọi tên
helper là "`dispatcher.notify`" và trỏ tới `dispatcher.ts:202-212` —
`RelayDispatcher.notify` ở đó thuộc 1 lớp khác, dùng cho pty-daemon (multi-
client fan-out), không phải cơ chế mà `agent.spawn`/`agent.execPrompt` chạy
trong process agent chính dùng. Cơ chế đúng, xác nhận bằng đọc code thật, là
`makeNotifier` trong `agent-rpc-dispatch.ts` — cùng file chứa
`dispatchAgentExecRpc`'s caller `route()`.)*

**Files cần sửa:**
1. `agent/src/relay/agent-print-mode-exec.ts` — thêm tham số `notify`, gọi
   trong 2 handler `data`.
2. `agent/src/relay/agent-rpc-dispatch-agent-exec.ts` — build `notify` từ
   `makeNotifier(ws, state)` tại `case 'agent.execPrompt'`, truyền xuống.
3. `agent/src/relay/agent-print-mode-exec.test.ts` — test mới.

---

## Implementation

### Part 1: `agent/src/relay/agent-print-mode-exec.ts`

Thêm tham số thứ 5, optional (không phá vỡ caller/test hiện có khi không
truyền — giữ đúng contract unary mà `SimpleExecutor`/`AgentExecutor` đang
`await`):

```typescript
export async function handleAgentExecPrompt(
  id: string | number | null,
  params: Record<string, unknown>,
  config: AgentConfig,
  log: AgentLogger,
  notify?: (method: string, params: Record<string, unknown>) => void // MỚI
): Promise<object> {
```

Trong khối `child.stdout?.on('data', ...)`/`child.stderr?.on('data', ...)`
(dòng 151-156 hiện tại), phát thêm 1 notification mỗi lần có chunk, giữ
nguyên phần nối chuỗi:

```typescript
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
```

Không đổi bất kỳ phần nào khác — `finish(...)`, timeout, response cuối
(dòng 177: `{ jsonrpc: '2.0', id, result: { ...result, stepId } }`) giữ
nguyên y hệt.

### Part 2: `agent/src/relay/agent-rpc-dispatch-agent-exec.ts`

Thêm `makeNotifier` vào import đã có từ `./agent-rpc-dispatch`:

```typescript
import { makeError, extractResume, makeNotifier } from './agent-rpc-dispatch'
```

Sửa `case 'agent.execPrompt'` (dòng 176-189 hiện tại) để build và truyền
`notify`:

```typescript
    case 'agent.execPrompt': {
      try {
        const { handleAgentExecPrompt } = await import('./agent-print-mode-exec')
        const notify = makeNotifier(ws, state)
        return (await handleAgentExecPrompt(
          rpc.id,
          rpc.params ?? {},
          config,
          log,
          notify
        )) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `agent.execPrompt unavailable: ${msg}`)
      }
    }
```

`dispatchAgentExecRpc` đã nhận `ws`/`state` trong signature (dòng 15-21) —
không cần đổi signature của hàm dispatch, chỉ dùng 2 tham số đã có sẵn.

---

## Wire Protocol

```jsonc
// Request (không đổi):
Backend → Agent: { "jsonrpc": "2.0", "id": 7, "method": "agent.execPrompt",
                    "params": { "prompt": "...", "worktreePath": "/repo", "stepId": "step-42" } }

// MỚI — 0..n notification trong lúc process còn chạy, không có "id":
Agent → Backend: { "jsonrpc": "2.0", "method": "agent.execPrompt.output",
                    "params": { "stepId": "step-42", "stream": "stdout", "data": "Thinking...\n" } }
Agent → Backend: { "jsonrpc": "2.0", "method": "agent.execPrompt.output",
                    "params": { "stepId": "step-42", "stream": "stderr", "data": "warning: ...\n" } }

// Response cuối (không đổi shape, vẫn mang đúng "id": 7):
Agent → Backend: { "jsonrpc": "2.0", "id": 7,
                    "result": { "stdout": "...", "stderr": "...", "exitCode": 0, "timedOut": false, "stepId": "step-42" } }
```

Không base64: stdout của `claude --print` là text UTF-8, không phải dữ liệu
terminal nhị phân như `pty.data`/`agent.output` — giữ string thô để backend
parse thẳng vào Activity Feed message (đúng quyết định của solution, không
lặp lại `pty.data`'s base64 encoding).

---

## Unit Tests to Add

File: `agent/src/relay/agent-print-mode-exec.test.ts` (thêm vào `describe('handleAgentExecPrompt', ...)` đã có)

```typescript
it('emits agent.execPrompt.output notifications for each stdout/stderr chunk', async () => {
  const notify = vi.fn()
  const promise = handleAgentExecPrompt(
    1,
    { prompt: 'hi', worktreePath: '/repo', stepId: 'step-42' },
    config,
    log,
    notify
  )
  const child = getLastSpawnedChild() // theo helper mock spawn đã dùng ở các test khác trong file này
  child.stdout.emit('data', Buffer.from('chunk-1'))
  child.stderr.emit('data', Buffer.from('warn-1'))
  child.emit('close', 0)
  await promise

  expect(notify).toHaveBeenCalledWith('agent.execPrompt.output', {
    stepId: 'step-42', stream: 'stdout', data: 'chunk-1'
  })
  expect(notify).toHaveBeenCalledWith('agent.execPrompt.output', {
    stepId: 'step-42', stream: 'stderr', data: 'warn-1'
  })
})

it('still resolves with the unchanged response shape when notify is omitted', async () => {
  const promise = handleAgentExecPrompt(
    2,
    { prompt: 'hi', worktreePath: '/repo' },
    config,
    log
    // notify omitted — backward-compat, các caller hiện tại (task-service qua
    // Relay unary) không truyền tham số này
  )
  const child = getLastSpawnedChild()
  child.stdout.emit('data', Buffer.from('done'))
  child.emit('close', 0)
  const result = await promise as any
  expect(result.result.stdout).toBe('done')
})
```

(Điều chỉnh theo đúng cách các test hiện có trong file lấy `child` đã spawn —
xem test `'invokes claude in --print mode...'` dòng 110-131 làm mẫu chính
xác cho cách mock `spawn`.)

File: `agent/src/relay/agent-rpc-dispatch-agent-exec.test.ts` (nếu file này
tồn tại; nếu chưa có test cho `case 'agent.execPrompt'`, thêm 1 test xác
nhận `makeNotifier(ws, state)` được truyền xuống — assert qua spy trên
`handleAgentExecPrompt`'s import, hoặc test tích hợp gửi `ws.send` mock và
kiểm tra frame notification được encode đúng).

---

## Verification

```bash
cd agent
npx tsc --noEmit -p config/tsconfig.node.json 2>&1 | grep -E "agent-print-mode-exec|agent-rpc-dispatch-agent-exec"
npx vitest run src/relay/agent-print-mode-exec.test.ts
```

---

## Không thuộc phạm vi task này

- Hạ tầng backend-go nhận `agent.execPrompt.output` (outbox CR-FLOW-TASK-003
  hoặc kênh riêng) — xem [SOL-AGENT-TASKV1-002](../solutions/SOL-AGENT-TASKV1-002-task-execute-worker-dispatch-primitives-unwired.md)'s
  Việc 1 và [BUG-AGENT-TASKV1-004](../BUG-AGENT-TASKV1-004-workflow-service-agent-step-executor-still-broken.md)
  (`workflow-service` phải tự sửa `agent.exec` → `agent.execPrompt` trước
  khi có thể nhận notification này — theo đúng thứ tự SOL-AGENT-TASKV1-003
  đề xuất).
- `shell.exec.output` — xem [TASK-AGENT-TASKV1-02](./TASK-AGENT-TASKV1-02-shell-exec-output-notification.md).
- `ai.complete` streaming — solution xác nhận rõ ngoài phạm vi (không phải
  subprocess buffer, cần tích hợp streaming API riêng của LLM provider).
