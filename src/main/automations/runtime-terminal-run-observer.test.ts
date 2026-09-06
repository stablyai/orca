import { describe, expect, it, vi } from 'vitest'
import { createRuntimeAutomationRunTerminalObserver } from './runtime-terminal-run-observer'
import { OrcaRuntimeService } from '../runtime/orca-runtime'

const PTY_ID = 'pty-automation'
const PANE_KEY = 'tab-automation:11111111-2222-4333-8444-555555555555'
const FINAL = 'CONFIG_STAMP: ORCA-HEALTH-2026-09-04-R14\r\nSTATUS: DONE\r\n'

function observe(connectionId: string | null = null) {
  const runtime = new OrcaRuntimeService()
  runtime.registerPty(PTY_ID, 'folder:automation', connectionId, {
    tabId: 'tab-automation',
    leafId: '11111111-2222-4333-8444-555555555555',
    incarnationId: 'incarnation-automation'
  })
  const observer = createRuntimeAutomationRunTerminalObserver(runtime)
  const handle = observer.resolveRunTerminal({ terminalPaneKey: PANE_KEY } as never)!
  expect(handle).toBeTruthy()
  const controller = new AbortController()
  const settled = vi.fn()
  const promise = observer.observeCompletion(handle, {
    signal: controller.signal,
    terminalPtyId: PTY_ID
  })
  void promise.then(settled, () => {})
  return { runtime, handle, controller, settled, promise }
}

describe('authority automation terminal exit observation', () => {
  it.each([null, 'ssh-automation'])(
    'waits for the owned %s process and captures before transcript retirement',
    async (connectionId) => {
      const run = observe(connectionId)
      try {
        run.runtime.onPtyData(PTY_ID, 'echoed prompt fragments\r\n', Date.now())
        run.runtime.onPtyData(PTY_ID, '\x1b]0;Claude — idle\x07', Date.now())
        await Promise.resolve()
        expect(run.settled).not.toHaveBeenCalled()
        run.runtime.onPtyData(PTY_ID, FINAL, Date.now())
        run.runtime.onPtyExit(PTY_ID, 0, 'incarnation-automation')
        const result = await run.promise
        expect(result.status).toBe('completed')
        expect(result.outputSnapshot?.content).toContain(FINAL.replaceAll('\r', '').trim())
        // The runtime intentionally frees this transcript during the same exit callback.
        expect((await run.runtime.readTerminal(run.handle)).tail).toEqual([])
      } finally {
        run.controller.abort()
      }
    }
  )

  it('rejects a stale incarnation exit while the owned process continues', async () => {
    const run = observe()
    run.runtime.onPtyExit(PTY_ID, 0, 'older-incarnation')
    await Promise.resolve()
    expect(run.settled).not.toHaveBeenCalled()
    run.runtime.onPtyData(PTY_ID, FINAL, Date.now())
    run.runtime.onPtyExit(PTY_ID, 0, 'incarnation-automation')
    expect((await run.promise).status).toBe('completed')
  })

  it('refuses a pane that now belongs to a different PTY', () => {
    const runtime = new OrcaRuntimeService()
    runtime.registerPty('replacement-pty', 'folder:automation', null, {
      tabId: 'tab-automation',
      leafId: '11111111-2222-4333-8444-555555555555',
      incarnationId: 'replacement-incarnation'
    })
    const observer = createRuntimeAutomationRunTerminalObserver(runtime)
    expect(
      observer.resolveRunTerminal({
        workspaceId: 'folder:automation',
        terminalPaneKey: PANE_KEY,
        terminalPtyId: PTY_ID
      } as never)
    ).toBeNull()
  })

  it('reports a real nonzero exit as failure with captured output', async () => {
    const run = observe()
    run.runtime.onPtyData(PTY_ID, 'launch failed\r\n', Date.now())
    run.runtime.onPtyExit(PTY_ID, 9, 'incarnation-automation')
    await expect(run.promise).resolves.toMatchObject({
      status: 'dispatch_failed',
      error: 'Automation process exited with code 9.',
      outputSnapshot: { content: 'launch failed' }
    })
  })

  it('never turns an unconfirmed SSH stop into success', async () => {
    const run = observe('ssh-automation')
    run.runtime.onPtyExit(PTY_ID, -1, 'incarnation-automation')
    await expect(run.promise).resolves.toMatchObject({
      status: 'dispatch_failed',
      error: expect.stringContaining('could be verified')
    })
  })

  it('releases both exit subscriptions when watching is aborted', async () => {
    const run = observe()
    const unsubscribe = vi.fn()
    const subscribe = vi.spyOn(run.runtime, 'subscribeToPtyExit').mockReturnValue(unsubscribe)
    const observer = createRuntimeAutomationRunTerminalObserver(run.runtime)
    const promise = observer.observeCompletion(run.handle, {
      signal: run.controller.signal,
      terminalPtyId: PTY_ID
    })
    run.controller.abort()
    await expect(promise).rejects.toThrow('request_aborted')
    await expect(run.promise).rejects.toThrow('request_aborted')
    expect(subscribe).toHaveBeenCalledWith(PTY_ID, expect.any(Function))
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
