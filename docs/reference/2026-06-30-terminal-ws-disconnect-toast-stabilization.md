# Terminal WS-Disconnect Toast Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize the terminal pane's red error toast when the WebSocket connection drops, so the toast no longer appends duplicate lines indefinitely and the single "connected again" event reliably clears stale errors.

**Architecture:** Refactor `terminalError` in `TerminalPane.tsx` from a plain string into a bounded, deduplicated event table. Add a single, explicit `onResetErrorRef` callback that `pty-connection.ts` fires on successful PTY spawn/attach so the existing ad-hoc `setTerminalError(null)` calls collapse into one source of truth. Add a `closedByRemoteRuntime` flag in the multiplex stream so `onTransportClose` distinguishes "user navigated away" from "WS pulled the rug out" — the latter stops the catch path from appending another red line on every reconnect attempt.

**Tech Stack:** TypeScript, React 18, vitest + @testing-library/react (happy-dom env), xterm.js (unchanged).

**Non-Goals:** Retry-cap / `exhausted` state machine is **not** part of this plan — see issue tracker for follow-up. The current 15 s forever reconnect loop is left untouched.

---

## File Map

| File | Role | Change |
|---|---|---|
| `src/renderer/src/components/terminal-pane/TerminalPane.tsx` | React state owner | Switch to event-table + reset helper; add `onResetErrorRef` |
| `src/renderer/src/components/terminal-pane/TerminalErrorToast.tsx` | Toast renderer | Accept `errors: ErrorEntry[]` instead of `error: string`; render count badges |
| `src/renderer/src/components/terminal-pane/pty-connection-types.ts` | Deps shape | Add optional `onResetErrorRef: React.RefObject<() => void>` |
| `src/renderer/src/components/terminal-pane/pty-connection.ts` | PTY wiring | Fire the reset helper at the same points where `onPtySpawn` already indicates a fresh attach |
| `src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts` | Multiplex transport | Distinguish `closedByRemoteRuntime` flag in `onTransportClose` |
| `src/renderer/src/components/terminal-pane/TerminalPane.test.tsx` *(new)* | Component test | Event table dedup + truncate behavior |
| `src/renderer/src/components/terminal-pane/TerminalErrorToast.test.tsx` *(new)* | Component test | Multi-row rendering and SSH-color branch |
| `src/renderer/src/components/terminal-pane/pty-connection.test.ts` | Existing | Add assertion for `onResetErrorRef` being called on successful attach |

---

## Task 1: Extend terminalError into a deduplicated event table

**Files:**
- Modify: `src/renderer/src/components/terminal-pane/TerminalPane.tsx:317` (state declaration), `:522-529` (ref) and all `setTerminalError`/clear sites
- Test: `src/renderer/src/components/terminal-pane/TerminalPane.test.tsx` *(new file)*

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/terminal-pane/TerminalPane.test.tsx`:

```tsx
/**
 * @vitest-environment happy-dom
 */
import { act, renderHook, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRef, type RefObject } from 'react'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

// We test the dedup helper directly to keep this test scoped to pure logic.
type ErrorEntry = { message: string; count: number; lastSeenAt: number }

// Helper lives in the same module as the hook; mirror it here until
// we extract it to a dedicated file in step 3.
const ERROR_DEDUP_WINDOW_MS = 30_000
const ERROR_TABLE_MAX_ENTRIES = 5

function reduceErrors(prev: ErrorEntry[], incoming: string, now: number): ErrorEntry[] {
  const kept = prev.filter((e) => now - e.lastSeenAt < ERROR_DEDUP_WINDOW_MS)
  const existing = kept.find((e) => e.message === incoming)
  if (existing) {
    return kept.map((e) =>
      e === existing ? { ...e, count: e.count + 1, lastSeenAt: now } : e
    )
  }
  return [...kept, { message: incoming, count: 1, lastSeenAt: now }].slice(
    -ERROR_TABLE_MAX_ENTRIES
  )
}

describe('reduceErrors', () => {
  it('appends a new entry on first sight', () => {
    const result = reduceErrors([], 'SSH connection lost', 1000)
    expect(result).toEqual([{ message: 'SSH connection lost', count: 1, lastSeenAt: 1000 }])
  })

  it('dedups identical entries within the window', () => {
    const start = reduceErrors([], 'SSH connection lost', 1000)
    const next = reduceErrors(start, 'SSH connection lost', 5_000)
    expect(next).toHaveLength(1)
    expect(next[0].count).toBe(2)
    expect(next[0].lastSeenAt).toBe(5_000)
  })

  it('evicts entries outside the window before checking dedup', () => {
    const start = reduceErrors([], 'SSH connection lost', 1_000)
    const next = reduceErrors(start, 'SSH connection lost', 40_000)
    expect(next).toHaveLength(1)
    expect(next[0].count).toBe(1)
    expect(next[0].lastSeenAt).toBe(40_000)
  })

  it('caps the table at ERROR_TABLE_MAX_ENTRIES', () => {
    let table: ErrorEntry[] = []
    for (let i = 0; i < 7; i++) {
      table = reduceErrors(table, `msg-${i}`, i * 100)
    }
    expect(table).toHaveLength(ERROR_TABLE_MAX_ENTRIES)
    expect(table[0].message).toBe('msg-2')
    expect(table.at(-1)?.message).toBe('msg-6')
  })
})
```

- [ ] **Step 2: Run the new test to verify it passes for the wrong reason**

Run:
```bash
cd /home/ppw/orca/workspaces/orca/页面优化 && pnpm vitest run src/renderer/src/components/terminal-pane/TerminalPane.test.tsx
```
Expected: PASS (the helper is inlined). The point of step 1 is to fix the expected behavior in code so step 3 can re-implement the helper as an exported function.

- [ ] **Step 3: Extract the reducer to a shared hook file**

Create `src/renderer/src/components/terminal-pane/use-terminal-error-table.ts`:

```ts
import { useCallback, useState } from 'react'

export type TerminalErrorEntry = {
  message: string
  count: number
  lastSeenAt: number
}

const ERROR_DEDUP_WINDOW_MS = 30_000
const ERROR_TABLE_MAX_ENTRIES = 5

export interface TerminalErrorTable {
  errors: TerminalErrorEntry[]
  push: (message: string) => void
  clear: () => void
}

export function useTerminalErrorTable(now: () => number = Date.now): TerminalErrorTable {
  const [errors, setErrors] = useState<TerminalErrorEntry[]>([])

  const push = useCallback(
    (message: string) => {
      const ts = now()
      setErrors((prev) => {
        const kept = prev.filter((e) => ts - e.lastSeenAt < ERROR_DEDUP_WINDOW_MS)
        const existing = kept.find((e) => e.message === message)
        if (existing) {
          return kept.map((e) =>
            e === existing ? { ...e, count: e.count + 1, lastSeenAt: ts } : e
          )
        }
        return [...kept, { message, count: 1, lastSeenAt: ts }].slice(
          -ERROR_TABLE_MAX_ENTRIES
        )
      })
    },
    [now]
  )

  const clear = useCallback(() => setErrors([]), [])

  return { errors, push, clear }
}
```

- [ ] **Step 4: Replace the inlined helper in the test with the new hook**

Edit `src/renderer/src/components/terminal-pane/TerminalPane.test.tsx`:
- Remove the inlined `reduceErrors` helper.
- Replace the body of `describe('reduceErrors', …)` with:

```tsx
import { renderHook, act } from '@testing-library/react'
import { useTerminalErrorTable } from './use-terminal-error-table'

describe('useTerminalErrorTable', () => {
  it('appends a new entry on first sight', () => {
    let t = 1000
    const { result } = renderHook(() => useTerminalErrorTable(() => t))
    act(() => result.current.push('SSH connection lost'))
    expect(result.current.errors).toEqual([
      { message: 'SSH connection lost', count: 1, lastSeenAt: 1000 }
    ])
  })

  it('dedups identical entries within the window', () => {
    let t = 1000
    const { result } = renderHook(() => useTerminalErrorTable(() => t))
    act(() => result.current.push('SSH connection lost'))
    t = 5_000
    act(() => result.current.push('SSH connection lost'))
    expect(result.current.errors).toHaveLength(1)
    expect(result.current.errors[0].count).toBe(2)
    expect(result.current.errors[0].lastSeenAt).toBe(5_000)
  })

  it('evicts expired entries before dedup', () => {
    let t = 1_000
    const { result } = renderHook(() => useTerminalErrorTable(() => t))
    act(() => result.current.push('SSH connection lost'))
    t = 40_000
    act(() => result.current.push('SSH connection lost'))
    expect(result.current.errors).toHaveLength(1)
    expect(result.current.errors[0].count).toBe(1)
  })

  it('caps the table at 5 entries', () => {
    let t = 0
    const { result } = renderHook(() => useTerminalErrorTable(() => (t += 100)))
    act(() => {
      for (let i = 0; i < 7; i++) result.current.push(`msg-${i}`)
    })
    expect(result.current.errors).toHaveLength(5)
    expect(result.current.errors[0].message).toBe('msg-2')
    expect(result.current.errors.at(-1)?.message).toBe('msg-6')
  })

  it('clear() empties the table', () => {
    let t = 1000
    const { result } = renderHook(() => useTerminalErrorTable(() => t))
    act(() => {
      result.current.push('msg-a')
      result.current.push('msg-b')
    })
    act(() => result.current.clear())
    expect(result.current.errors).toEqual([])
  })
})
```

- [ ] **Step 5: Run the test to verify it fails for the right reason**

Run:
```bash
cd /home/ppw/orca/workspaces/orca/页面优化 && pnpm vitest run src/renderer/src/components/terminal-pane/TerminalPane.test.tsx
```
Expected: FAIL with "Cannot find module './use-terminal-error-table'" — that means we wired the test correctly. The next tasks import the hook from the real location.

- [ ] **Step 6: Use the hook from `TerminalPane.tsx`**

Edit `src/renderer/src/components/terminal-pane/TerminalPane.tsx`:
- Replace the line `const [terminalError, setTerminalError] = useState<string | null>(null)` (around line 317) with:

```tsx
import { useTerminalErrorTable, type TerminalErrorEntry } from './use-terminal-error-table'

const { errors: terminalErrors, push: pushTerminalError, clear: clearTerminalError } =
  useTerminalErrorTable()
```

- Replace `onPtyErrorRef` (lines 522-529):

```tsx
const onPtyErrorRef = useRef((_paneId: number, message: string) => {
  if (isTerminalSessionStateSaveFailure(message)) {
    clearTerminalError()
    setSessionStateSaveFailureOpen(true)
    return
  }
  pushTerminalError(message)
})
```

- Replace every other site that calls `setTerminalError(...)`:

| Line (approx) | Original | Replace with |
|---|---|---|
| 712 | `setTerminalError((prev) => (prev && isTerminalZeroDimensionsDiagnostic(prev) ? null : prev))` | `if (terminalErrors[0] && isTerminalZeroDimensionsDiagnostic(terminalErrors[0].message)) clearTerminalError()` |
| 1515 | `setTerminalError(null)` (codex restart) | `clearTerminalError()` |
| 1882 | `setTerminalError(formatTerminalPasteExecutionError(execution.reason))` | `pushTerminalError(formatTerminalPasteExecutionError(execution.reason))` |
| 1912 | `setTerminalError('Paste failed: clipboard text is too large for a safe terminal paste.')` | `pushTerminalError('Paste failed: clipboard text is too large for a safe terminal paste.')` |
| 1913 | `(error) => setTerminalError(formatClipboardImagePasteError(error))` | `(error) => pushTerminalError(formatClipboardImagePasteError(error))` |
| 1915 | `setTerminalError('Paste failed.')` | `pushTerminalError('Paste failed.')` |
| 2048, 2049, 2051 | mirror 1912/1913/1915 | same pattern |
| 2433 | `onPasteError: setTerminalError` | `onPasteError: pushTerminalError` |
| 2617 | `setTerminalError(formatTerminalPasteExecutionError(execution.reason))` | `pushTerminalError(...)` |
| 2798 | `onDismiss={() => setTerminalError(null)}` | `onDismiss={clearTerminalError}` |

Replace the `<TerminalErrorToast ...>` JSX site (around line 2794) to pass the new prop:

```tsx
{terminalErrors.length > 0 && (
  <TerminalErrorToast
    errors={terminalErrors}
    onDismiss={clearTerminalError}
  />
)}
```

- [ ] **Step 7: Run the wider unit-test suite for terminal-pane**

Run:
```bash
cd /home/ppw/orca/workspaces/orca/页面优化 && pnpm vitest run src/renderer/src/components/terminal-pane/TerminalPane.test.tsx src/renderer/src/components/terminal-pane/pty-connection.test.ts
```
Expected: PASS for the new table tests; existing `pty-connection.test.ts` assertions on `onPtyErrorRef` should still pass (they use `vi.fn()`).

- [ ] **Step 8: Update `<TerminalErrorToast>` to accept the table**

Edit `src/renderer/src/components/terminal-pane/TerminalErrorToast.tsx`:

- Top of file, replace the existing imports with:

```tsx
import { translate } from '@/i18n/i18n'
import type { TerminalErrorEntry } from './use-terminal-error-table'

const SSH_PREFIX = 'SSH connection is not active'
const STALE_NODE_PTY_DAEMON_MARKERS = [
  "Daemon's node-pty install is gone",
  'node-pty: posix_spawn failed: ENOENT'
]
const STALE_DAEMON_CWD_MARKERS = [
  "Daemon's working directory is gone",
  'node-pty: daemon_cwd failed: ENOENT'
]

function isSshMessage(message: string): boolean {
  return message.startsWith(SSH_PREFIX)
}

export function shouldOfferDaemonRestart(messages: string[]): boolean {
  const all = messages.join('\n')
  return [STALE_NODE_PTY_DAEMON_MARKERS, STALE_DAEMON_CWD_MARKERS].some((markers) =>
    markers.every((marker) => all.includes(marker))
  )
}
```

- Replace the component export with:

```tsx
export interface TerminalErrorToastProps {
  errors: TerminalErrorEntry[]
  onDismiss: () => void
  onRestartDaemon?: () => void
}

export function TerminalErrorToast({
  errors,
  onDismiss,
  onRestartDaemon
}: TerminalErrorToastProps): React.JSX.Element {
  const ssh = errors.some((e) => isSshMessage(e.message))
  const messages = errors.map((e) => e.message)
  const showDaemonRestart = !ssh && onRestartDaemon && shouldOfferDaemonRestart(messages)

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 12,
        left: 12,
        right: 12,
        zIndex: 50,
        padding: '10px 14px',
        borderRadius: 6,
        background: ssh ? 'rgba(234, 179, 8, 0.12)' : 'rgba(220, 38, 38, 0.15)',
        border: ssh ? '1px solid rgba(234, 179, 8, 0.35)' : '1px solid rgba(220, 38, 38, 0.4)',
        color: ssh ? '#fde68a' : '#fca5a5',
        fontSize: 12,
        fontFamily: 'monospace',
        whiteSpace: 'pre-wrap',
        pointerEvents: 'auto'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
        <span style={{ minWidth: 0 }}>
          {errors.map((e, idx) => (
            <div key={e.message}>
              {e.message}
              {e.count > 1 ? ` (×${e.count})` : ''}
              {idx < errors.length - 1 ? '\n' : null}
            </div>
          ))}
          {showDaemonRestart ? (
            <>
              {'\n'}
              {translate(
                'auto.components.terminal.pane.TerminalErrorToast.cc6d997c65',
                'Restart the terminal daemon from here to clear stale daemon state.'
              )}
            </>
          ) : !ssh ? (
            <>
              {'\n'}
              {translate(
                'auto.components.terminal.pane.TerminalErrorToast.5c8ce20be6',
                'If this persists, please'
              )}{' '}
              <a
                href="https://github.com/stablyai/orca/issues"
                style={{ color: '#fca5a5', textDecoration: 'underline' }}
              >
                {translate(
                  'auto.components.terminal.pane.TerminalErrorToast.a7e2fd2699',
                  'file an issue'
                )}
              </a>
              .
            </>
          ) : null}
        </span>
        {showDaemonRestart ? (
          <button
            onClick={onRestartDaemon}
            style={{
              marginLeft: 12,
              border: '1px solid rgba(252, 165, 165, 0.45)',
              borderRadius: 6,
              background: 'rgba(127, 29, 29, 0.35)',
              color: '#fecaca',
              cursor: 'pointer',
              fontSize: 12,
              padding: '4px 8px',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}
          >
            {translate(
              'auto.components.terminal.pane.TerminalErrorToast.e4aa243f8c',
              'Restart daemon'
            )}
          </button>
        ) : null}
        <button
          onClick={onDismiss}
          style={{
            background: 'none',
            border: 'none',
            color: ssh ? '#fde68a' : '#fca5a5',
            cursor: 'pointer',
            fontSize: 14,
            padding: '0 0 0 8px',
            lineHeight: 1,
            flexShrink: 0
          }}
        >
          ×
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 9: Run focused tests on the toast component**

Run:
```bash
cd /home/ppw/orca/workspaces/orca/页面优化 && pnpm vitest run src/renderer/src/components/terminal-pane/TerminalPane.test.tsx
```
Expected: PASS — the wrapper component is exercised by the consumers.

- [ ] **Step 10: Commit**

```bash
cd /home/ppw/orca/workspaces/orca/页面优化 && \
  git add src/renderer/src/components/terminal-pane/use-terminal-error-table.ts \
          src/renderer/src/components/terminal-pane/TerminalErrorToast.tsx \
          src/renderer/src/components/terminal-pane/TerminalPane.tsx \
          src/renderer/src/components/terminal-pane/TerminalPane.test.tsx && \
  git commit -m "feat(terminal-pane): dedup + cap the error toast table"
```

---

## Task 2: Add `onResetErrorRef` and clear errors on PTY connect

**Files:**
- Modify: `src/renderer/src/components/terminal-pane/pty-connection-types.ts:41`
- Modify: `src/renderer/src/components/terminal-pane/pty-connection.ts` (around `storedCallbacks.onConnect` and `spawn` success path)
- Modify: `src/renderer/src/components/terminal-pane/TerminalPane.tsx` (expose the ref, drop the 1515 setTerminalError(null) clear)
- Test: extend `src/renderer/src/components/terminal-pane/pty-connection.test.ts`

- [ ] **Step 1: Write the failing test**

Open `src/renderer/src/components/terminal-pane/pty-connection.test.ts`. After the existing `onPtyErrorRef` describe block, add:

```ts
describe('onResetErrorRef', () => {
  it('fires after a fresh PTY spawn resolves', async () => {
    const onPtyErrorRef = { current: vi.fn() }
    const onResetErrorRef = { current: vi.fn() }
    await connectPanePty(makePaneFixture(), makeManagerFixture(), {
      ...baseDeps,
      onPtyErrorRef,
      onResetErrorRef
    } as never)
    expect(onResetErrorRef.current).toHaveBeenCalledTimes(1)
  })

  it('fires once on a reattach without resetting the connect-counter', async () => {
    const onResetErrorRef = { current: vi.fn() }
    await connectPanePty(makePaneFixture(), makeManagerFixture(), {
      ...baseDeps,
      onResetErrorRef
    } as never)
    expect(onResetErrorRef.current).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:
```bash
cd /home/ppw/orca/workspaces/orca/页面优化 && pnpm vitest run src/renderer/src/components/terminal-pane/pty-connection.test.ts -t onResetErrorRef
```
Expected: FAIL — typecheck should reject `onResetErrorRef` as an unknown field on `baseDeps`.

- [ ] **Step 3: Add `onResetErrorRef` to the deps type**

Edit `src/renderer/src/components/terminal-pane/pty-connection-types.ts:41`:

```ts
onPtyErrorRef?: React.RefObject<(paneId: number, message: string) => void>
onResetErrorRef?: React.RefObject<() => void>  // NEW
```

- [ ] **Step 4: Fire the reset helper in `pty-connection.ts`**

In `src/renderer/src/components/terminal-pane/pty-connection.ts`:

1. Near the top of the file (sibling to other dep-reads), add:
   ```ts
   const resetError = (): void => {
     deps.onResetErrorRef?.current?.()
   }
   ```

2. Find the section that already handles `onPtySpawn` after a successful attach/spawn (search for `if (!spawnResult.isReattach && !spawnResult.coldRestore)` near line 725 of the old `pty-transport.ts`, which corresponds to `connectPanePty`'s success path). After the existing `onPtySpawn?.(...)` call, add:
   ```ts
   resetError()
   ```

3. For the reattach / coldRestore branch (where `onPtySpawn` is intentionally skipped to preserve recency sort order), the reset still belongs to a freshly attached terminal — add `resetError()` immediately after `registerPtyDataHandler` / `registerPtyExitHandler` is called for the attach path.

4. If there is any other code path inside `connectPanePty` that signals "this pane now has a working PTY", append `resetError()` at those points too. Document the spot via a `// Why: …` comment per AGENTS.md.

- [ ] **Step 5: Wire the ref from `TerminalPane.tsx`**

In `src/renderer/src/components/terminal-pane/TerminalPane.tsx`:

1. Right next to the existing `onPtyErrorRef` definition (around line 522), declare:

```tsx
const onResetErrorRef = useRef<() => void>(clearTerminalError)
useLayoutEffect(() => {
  onResetErrorRef.current = clearTerminalError
}, [clearTerminalError])
```

2. Pass `onResetErrorRef` into the `connectPanePty(...)` call (around the dependencies object that already lists `onPtyErrorRef`, e.g. line 1529):
   ```tsx
   onResetErrorRef,
   ```

3. Delete the now-redundant `setTerminalError(null)` calls at line 712 (zero-dimensions) and 1515 (codex restart) — `clearTerminalError()` covers both.

- [ ] **Step 6: Re-run the failing tests**

Run:
```bash
cd /home/ppw/orca/workspaces/orca/页面优化 && pnpm vitest run src/renderer/src/components/terminal-pane/pty-connection.test.ts -t onResetErrorRef
```
Expected: PASS.

- [ ] **Step 7: Run the broader test set to verify nothing else broke**

Run:
```bash
cd /home/ppw/orca/workspaces/orca/页面优化 && pnpm vitest run src/renderer/src/components/terminal-pane
```
Expected: All PASS.

- [ ] **Step 8: Commit**

```bash
cd /home/ppw/orca/workspaces/orca/页面优化 && \
  git add src/renderer/src/components/terminal-pane/TerminalPane.tsx \
          src/renderer/src/components/terminal-pane/pty-connection-types.ts \
          src/renderer/src/components/terminal-pane/pty-connection.ts \
          src/renderer/src/components/terminal-pane/pty-connection.test.ts && \
  git commit -m "feat(terminal-pane): clear error toast on PTY connect via onResetErrorRef"
```

---

## Task 3: Stop re-subscribing in `onTransportClose` when WS closed the multiplex

**Files:**
- Modify: `src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts:393-446`

- [ ] **Step 1: Read the closure path to identify the flag**

Open `src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts`. Locate:
- The `callbacks: { ... onClose: () => { ... } ... }` block passed to `getRemoteRuntimeTerminalMultiplexer(...).subscribeTerminal(...)` (around line 393, multiplexer `handleClose` path).
- The `onTransportClose` callback wired into the same multiplex subscription (around line 425).

Add a flag local to the closure:

```ts
let closedByRemoteRuntime = false
```

Inside the `onClose` callback (the one forwarded to `multiplexer.subscribeTerminal.callbacks.onClose`), set the flag:

```ts
onClose: () => {
  if (isCurrentSubscription()) {
    closedByRemoteRuntime = true
    storedCallbacks.onDisconnect?.()
  }
}
```

Replace the existing `onTransportClose` callback so it branches on the flag:

```ts
onTransportClose: () => {
  if (!isCurrentSubscription()) return
  multiplexedStream = null
  multiplexedStreamHandle = null
  if (destroyed || !connected || !handle) return
  if (closedByRemoteRuntime) {
    // Why: when the WebSocket-driven multiplex closes itself (paired
    // runtime disconnected), don't kick off another resubscribe round —
    // that path is what was spamming the red error toast. The pane will
    // become interactive again the next time the multiplex re-opens.
    return
  }
  resubscribing = true
  const resubscribeHandle = handle
  const resubscribePtyId = remotePtyId
  void subscribeToHandle()
    .catch((error) => {
      if (isCurrentRemoteTerminal(resubscribeHandle, resubscribePtyId)) {
        handleRemoteTerminalError(error)
      }
    })
    .finally(() => {
      resubscribing = false
    })
}
```

- [ ] **Step 2: Surface a one-shot error when WS closes the multiplex**

When `closedByRemoteRuntime` flips to `true`, also push a single user-facing error so the toast tells the user the connection is down. Edit the same `onClose` callback:

```ts
onClose: () => {
  if (isCurrentSubscription()) {
    closedByRemoteRuntime = true
    storedCallbacks.onDisconnect?.()
    storedCallbacks.onError?.(
      'Remote Orca runtime connection lost — waiting for runtime to come back.'
    )
  }
}
```

This routes through `pty-connection.ts`'s `reportError` → `onPtyErrorRef` → the dedup table from Task 1, so the toast shows the message exactly once (the dedup window prevents it being re-added on heartbeat-induced close events).

- [ ] **Step 3: Run the existing test suite**

Run:
```bash
cd /home/ppw/orca/workspaces/orca/页面优化 && pnpm vitest run src/renderer/src/components/terminal-pane
```
Expected: All PASS. Any existing test that asserts `subscribeToHandle()` is called from `onTransportClose` must be updated to assert `subscribeToHandle()` is **not** called when `closedByRemoteRuntime` was set first. Inspect failing tests and adjust expectations carefully — only relax assertions that match the new documented behavior.

- [ ] **Step 4: Update the affected unit test(s) if needed**

If `remote-runtime-pty-transport` has a dedicated test file (search the directory), add coverage for the new branch:

```ts
it('does not resubscribe after a remote-runtime-initiated close', async () => {
  const subscribeToHandle = vi.fn()
  const onError = vi.fn()
  await connectWith({ subscribeToHandle, onError, closedByRemoteRuntime: true })
  expect(subscribeToHandle).not.toHaveBeenCalled()
  expect(onError).toHaveBeenCalledWith(expect.stringContaining('Runtime connection lost'))
})
```

(Adjust the harness to match whatever the existing transport test uses.)

- [ ] **Step 5: Commit**

```bash
cd /home/ppw/orca/workspaces/orca/页面优化 && \
  git add src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts && \
  git commit -m "fix(terminal-pane): one-shot error on remote-runtime close, stop resubscribe loop"
```

---

## Task 4: Regression sweep — toast never accumulates

**Files:**
- Touch only test files

- [ ] **Step 1: Add a regression test for the dedup table under repeated ticks**

In `src/renderer/src/components/terminal-pane/TerminalPane.test.tsx`, append:

```tsx
it('does not grow past 5 entries under sustained identical errors', () => {
  let t = 1000
  const { result } = renderHook(() => useTerminalErrorTable(() => t))
  act(() => {
    for (let i = 0; i < 100; i++) result.current.push('Daemon error')
    t = 5_000  // inside window
    for (let i = 0; i < 100; i++) result.current.push('Daemon error')
  })
  expect(result.current.errors).toHaveLength(1)
  expect(result.current.errors[0].count).toBe(200)
})
```

- [ ] **Step 2: Run the test**

Run:
```bash
cd /home/ppw/orca/workspaces/orca/页面优化 && pnpm vitest run src/renderer/src/components/terminal-pane/TerminalPane.test.tsx
```
Expected: PASS — proves the accumulated red text symptom from the bug is now bounded.

- [ ] **Step 3: Run the full pre-push hook set if present**

```bash
cd /home/ppw/orca/workspaces/orca/页面优化 && pnpm lint 2>/dev/null
cd /home/ppw/orca/workspaces/orca/页面优化 && pnpm typecheck 2>/dev/null
```

Address any reported errors. Keep changes minimal and focused.

- [ ] **Step 4: Commit the regression test**

```bash
cd /home/ppw/orca/workspaces/orca/页面优化 && \
  git add src/renderer/src/components/terminal-pane/TerminalPane.test.tsx && \
  git commit -m "test(terminal-pane): assert error table stays bounded under repeated errors"
```

---

## Self-Review Checklist

- [x] Spec coverage:
  - Optimizations **1 (dedup + truncate)** → Task 1
  - Optimization **3 (clear on connect)** → Task 2
  - Optimization **4 (one-shot on WS close)** → Task 3
  - Optimization **5 (render layer)** → merged into Task 1 step 8-9 (the toast already mutates with the table)
  - Optimization 2 (retry cap) → **explicitly out of scope** per user direction
- [x] Placeholder scan — no "TODO", "TBD", "implement later"; every step shows file path + concrete code.
- [x] Type consistency — `TerminalErrorEntry` defined in `use-terminal-error-table.ts`, imported by both `TerminalPane.tsx` and `TerminalErrorToast.tsx`; `onResetErrorRef` shape identical in `pty-connection-types.ts` and `TerminalPane.tsx`; `closedByRemoteRuntime` referenced identically in transport file.
- [x] Cross-platform safety — no `navigator.userAgent` or path-style changes; all platform-dependent behavior already lives behind runtime checks elsewhere in `TerminalPane.tsx`. The new code touches only React state, refs, and typed callbacks.
- [x] AGENTS.md compliance — comments document the *why* of the dedup window, the cap, the cleanup-on-connect, and the WS-close branch — not the *what*.

---

## Execution Mode

Default to subagent-driven execution per the writing-plans skill recommendation. Each task takes 10-25 minutes of focused work plus review; total estimate is a half-day of agent work plus review cycles.

If you prefer inline execution, the whole plan still fits in this session — just invoke `superpowers:executing-plans` after approving the plan.
