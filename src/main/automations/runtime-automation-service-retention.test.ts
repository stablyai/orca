import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../shared/automations-types'
import { RUN_TERMINAL_GRACE_MS } from './headless-run-terminal-retention'

vi.mock('./service', () => ({
  AutomationService: class {
    start = vi.fn()
    stop = vi.fn()
    markDispatchResult = vi.fn(async () => ({}))
  }
}))

import { createRuntimeAutomationService } from './runtime-automation-service'

function finishedRuns(count: number): AutomationRun[] {
  return Array.from(
    { length: count },
    (_, n) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: retention reads only these run fields.
      ({
        id: `r${n}`,
        automationId: 'nightly',
        status: 'completed',
        error: null,
        terminalPaneKey: `tab-${n}:1`,
        terminalPtyId: `pty-${n}`,
        dispatchedAt: n,
        startedAt: n,
        createdAt: n
      }) as AutomationRun
  )
}

function build(headless: boolean) {
  const runtime = {
    setAutomationService: vi.fn(),
    notifyAutomationsChanged: vi.fn(),
    getTerminalHandleForPaneKey: vi.fn((paneKey: string) => `handle:${paneKey}`),
    // Each run's pane still holds its own PTY unless a test restarts it.
    getTerminalPtyIdForHandle: vi.fn((handle: string) => `pty-${handle.split('tab-')[1]?.[0]}`),
    // pty-1's terminal has a client on it: typed into or being viewed.
    readTerminalClientUse: vi.fn((ptyId: string) => (ptyId === 'pty-1' ? 'used' : 'unused')),
    closeTerminal: vi.fn(async (_handle: string) => ({})),
    confirmTerminalShellAlone: vi.fn(async (_ptyId: string) => false),
    closeTerminalTab: vi.fn(async (_handle: string) => ({}))
  }
  const store = { listAutomationRuns: vi.fn(() => finishedRuns(5)), listAutomations: () => [] }
  const service = createRuntimeAutomationService({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked service and retention read only listAutomationRuns.
    store: store as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: retention reads only the members faked above.
    runtime: runtime as never,
    headless
  })
  return { runtime, service, store }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('headless automation service run terminal retention', () => {
  it('closes finished run terminals on orcad once the service runs, and stops with it', async () => {
    vi.useFakeTimers()
    const { runtime, service } = build(true)
    service.start()
    await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS + 2 * 60_000)

    // The oldest two finished runs are past the newest three; the one a client used stays open.
    // Only the run's own pane closes: a pane a user split into its tab survives.
    expect(runtime.closeTerminal.mock.calls.map(([handle]) => handle)).toEqual(['handle:tab-0:1'])
    expect(runtime.closeTerminalTab).not.toHaveBeenCalled()
    expect(service.markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'r0', status: 'completed', terminalPaneKey: null })
    )

    service.stop()
    runtime.closeTerminal.mockClear()
    await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS * 2)
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('closes nothing in a pane a restart gave a new PTY, and still forgets the old one', async () => {
    vi.useFakeTimers()
    const { runtime, service } = build(true)
    // The oldest run's pane was restarted (exited pane, account switch): a user's PTY lives there.
    runtime.getTerminalPtyIdForHandle.mockImplementation((handle: string) =>
      handle === 'handle:tab-0:1' ? 'pty-user' : `pty-${handle.split('tab-')[1]?.[0]}`
    )
    service.start()
    await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS + 2 * 60_000)

    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(service.markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'r0', terminalPaneKey: null, terminalPtyId: null })
    )
    service.stop()
  })

  it('fails and closes a dispatched run whose agent exited, proven by its shell alone', async () => {
    vi.useFakeTimers()
    const { runtime, service, store } = build(true)
    store.listAutomationRuns.mockReturnValue([
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: retention reads only these run fields.
      { ...finishedRuns(1)[0], status: 'dispatched' } as AutomationRun
    ])
    runtime.confirmTerminalShellAlone.mockResolvedValue(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked service exposes the drain hook it was given.
    const drain = (service as unknown as { releaseFinishedRunTerminals: () => Promise<number> })
      .releaseFinishedRunTerminals
    await expect(drain()).resolves.toBe(1)
    expect(runtime.confirmTerminalShellAlone).toHaveBeenCalledWith('pty-0')
    expect(service.markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'r0', status: 'dispatch_failed', terminalPtyId: null })
    )
  })

  it('leaves run terminals to the renderer on the desktop', async () => {
    vi.useFakeTimers()
    const { runtime, service } = build(false)
    service.start()
    await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS * 2)
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })
})
