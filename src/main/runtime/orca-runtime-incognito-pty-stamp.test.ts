import { describe, expect, it } from 'vitest'
import { createInventoryRuntime, PTY, WORKTREE } from './pty-inventory-lifecycle-fixture'
import type { InventoryLifecycleRuntime } from './pty-inventory-lifecycle-fixture'

// Finding: the renderer-backed (UI) create path registers the PTY through registerPty's binding, so
// stamping `incognito` there is what makes `isTerminalHandleIncognito` — the exact read-site the
// orchestration worker-output-archive guard calls — agree with the daemon's scrollback suppression.
// Behavioral: register as the spawn-commit path does and read the public handle predicate.
const TAB = '41000000-0000-4000-8000-000000000001'
const LEAF = '41000000-0000-4000-8000-000000000002'
const INCARNATION = '41000000-0000-4000-8000-000000000003'
const HANDLE = `term_${INCARNATION}`

function registerPtyWith(runtime: InventoryLifecycleRuntime, opts: { incognito?: boolean }): void {
  runtime.registerPreAllocatedHandleForPty(PTY, HANDLE)
  runtime.registerPty(PTY, WORKTREE, null, {
    tabId: TAB,
    leafId: LEAF,
    incarnationId: INCARNATION,
    terminalHandle: HANDLE,
    ...(opts.incognito ? { incognito: true } : {})
  })
}

describe('incognito runtime pty-record stamping (renderer-backed desktop path)', () => {
  it('stamps pty.incognito so the worker-output-archive guard (isTerminalHandleIncognito) trips', () => {
    const { runtime } = createInventoryRuntime(async () => [])
    registerPtyWith(runtime, { incognito: true })
    expect(runtime.isTerminalHandleIncognito(HANDLE)).toBe(true)
  })

  it('reads false for a non-incognito registration (the stamp is load-bearing, not always on)', () => {
    const { runtime } = createInventoryRuntime(async () => [])
    registerPtyWith(runtime, {})
    expect(runtime.isTerminalHandleIncognito(HANDLE)).toBe(false)
  })

  it('never downgrades: a re-registration that omits the flag keeps the terminal incognito', () => {
    const { runtime } = createInventoryRuntime(async () => [])
    registerPtyWith(runtime, { incognito: true })
    // Restart re-adoption or a mobile-surface publish can re-register without re-passing the flag;
    // incognito is a stable per-session property and must not silently clear.
    runtime.registerPty(PTY, WORKTREE, null, {
      tabId: TAB,
      leafId: LEAF,
      incarnationId: INCARNATION,
      terminalHandle: HANDLE
    })
    expect(runtime.isTerminalHandleIncognito(HANDLE)).toBe(true)
  })
})
