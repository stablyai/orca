# TASK-AG-FLOWTASK-001: Wire `agent.execOutput` notification into `handleAgentExecPrompt`

**Task ID:** TASK-AG-FLOWTASK-001
**Priority:** 🔵 P3 (Phase D of CR-FLOW-TASK-003 — design-only, not scheduled)
**Solution Ref:** [SOL-AG-FLOWTASK-001](../solutions/SOL-AG-FLOWTASK-001-execution-activity-streaming-design.md) §2.1
**Depends on:** None within `agent/` itself (self-contained), but the notification this task
produces has **no consumer** until TASK-AG-FLOWTASK-002 ships — implementing this alone is
inert, not harmful.
**Status:** [ ] TODO (chờ quyết định triển khai — không phải TODO ngay)

> **Không bắt đầu code cho tới khi ai đó quyết định lên lịch triển khai phần
> streaming của CR-FLOW-TASK-003.** Task này chỉ ghi lại thiết kế đã có trong
> SOL-AG-FLOWTASK-001 ở dạng sẵn sàng cầm lên làm, không phải một task đang
> chờ nhận việc ngay.

---

## Context

**Files:** `agent/src/relay/agent-print-mode-exec.ts`, `agent/src/relay/agent-rpc-dispatch-agent-exec.ts`

**Problem:** `handleAgentExecPrompt` accumulates `child.stdout`/`child.stderr` into strings and
resolves exactly once on `close` (`agent-print-mode-exec.ts:124-163`) — no incremental delivery.
The `'agent.execPrompt'` dispatch case (`agent-rpc-dispatch-agent-exec.ts:176-189`) does not pass
`ws`/`state` to the handler, so it has no way to call `makeNotifier()` even though that mechanism
already exists and is already used by `pty.create`/`pty.attach`.

## Implementation Sketch (from SOL-AG-FLOWTASK-001 §2.1 — not final, see Open Questions)

```typescript
// agent/src/relay/agent-print-mode-exec.ts — add optional notify param
export async function handleAgentExecPrompt(
  id: string | number | null,
  params: Record<string, unknown>,
  config: AgentConfig,
  log: AgentLogger,
  notify?: (method: string, params: Record<string, unknown>) => void   // NEW — optional, backward-compatible
): Promise<object> {
  // ...
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
  // ... final response shape UNCHANGED: { stdout, stderr, exitCode, timedOut, stepId }
}
```

```typescript
// agent/src/relay/agent-rpc-dispatch-agent-exec.ts — case 'agent.execPrompt'
case 'agent.execPrompt': {
  const { handleAgentExecPrompt } = await import('./agent-print-mode-exec')
  return (await handleAgentExecPrompt(
    rpc.id, rpc.params ?? {}, config, log,
    makeNotifier(ws, state)   // NEW — same pattern as pty.create/pty.attach
  )) as JsonRpcResponse
}
```

Design intent: **additive only** — the final unary response's shape does not change, so
`SimpleExecutor`, `StepExecutors.executeAgent()`, and `ProfileAwareAgentSpawner.spawn()` keep
working unmodified even if they never read the new notification.

## Open Questions To Resolve Before Coding (SOL-AG-FLOWTASK-001 §5)

1. **Granularity** — send on every raw `data` event, or line-buffer (batch to `\n`, mirroring
   `pty.data`'s Part B 8ms batching)? No precedent exists for this specific RPC.
2. **Size cap** — `agent.execPrompt` today has no stdout/stderr cap (unlike
   `agent.execNonInteractive`'s 4MB/stream). Streaming does not automatically add one; decide a
   cap for both the accumulated final buffer and each notification chunk.
3. Confirm this does not regress the shared `ws`/`WireState` connection that also carries live PTY
   traffic (`pty.data`, `agent.spawn`'s `agent.output`) — no flow-control mechanism equivalent to
   Part B's `notifyBulk` exists yet for Part A notifications.

## Tests To Add (once granularity is decided)

File: `agent/src/relay/agent-print-mode-exec.test.ts` (or equivalent existing suite)

- `handleAgentExecPrompt` with no `notify` passed still resolves with the same final shape
  (backward-compat regression guard).
- `handleAgentExecPrompt` with `notify` passed emits `agent.execOutput` for each stdout/stderr
  chunk per the chosen granularity policy, and never emits after `close`.
- Final response's `stdout`/`stderr` content is unaffected by whether `notify` is passed.

## Verification

```bash
cd agent && npx tsc --noEmit
cd agent && npx vitest run src/relay/agent-print-mode-exec.test.ts
```

---

## Acceptance Criteria

- [ ] `handleAgentExecPrompt` accepts an optional `notify` callback without changing its return
      shape for existing callers.
- [ ] `case 'agent.execPrompt'` passes `makeNotifier(ws, state)` through.
- [ ] Granularity and size-cap open questions (above) are explicitly decided and documented in
      code comments, not left implicit.
- [ ] Existing `agent.execPrompt` callers' tests pass unmodified.
