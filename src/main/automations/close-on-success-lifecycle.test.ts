import { describe, expect, it } from 'vitest'
import { setup, snapshot } from './close-on-success.test-fixture'

describe('close-on-success completion lifecycle', () => {
  it.each(['used', 'unknown'] as const)(
    'rechecks client use after asynchronous shell confirmation becomes %s',
    async (use) => {
      const h = await setup()
      const { automation, run } = h.launch()
      h.runtime.getAgentStatusRowsForPane.mockReturnValue([])
      let confirm = (_alone: boolean) => {}
      const gate = new Promise<boolean>((resolve) => {
        confirm = resolve
      })
      let entered = () => {}
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      h.runtime.confirmTerminalShellAlone.mockImplementationOnce(async () => {
        entered()
        return gate
      })
      await h.service.markDispatchResult({
        runId: run.id,
        status: 'completed',
        outputSnapshot: snapshot
      })
      await started
      h.runtime.readTerminalClientUse.mockReturnValue(use)
      confirm(true)
      await h.service.reconcileFinishedRunTerminals?.()
      await h.settle(automation.id)
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
      expect(h.store.listAutomationRuns()[0]).toMatchObject({
        status: 'completed',
        terminalPtyId: 'pty-run'
      })
      expect(h.panes.size).toBe(2)
    }
  )

  it('observes a working turn through completion, captures output, saves usage, and closes only its pane', async () => {
    const h = await setup()
    const { automation, run } = h.launch()
    const done = h.runtime.getAgentStatusRowsForPane()[0]
    h.runtime.getAgentStatusRowsForPane.mockReturnValue([
      { state: 'working', stateStartedAt: Date.now() }
    ])
    let finish = (_result: { satisfied: boolean }) => {}
    const idle = new Promise<{ satisfied: boolean }>((resolve) => {
      finish = resolve
    })
    let entered = () => {}
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    h.runtime.waitForTerminal
      .mockRejectedValueOnce(new Error('timeout'))
      .mockImplementation(async () => {
        entered()
        return idle
      })
    let didClose = () => {}
    const closed = new Promise<void>((resolve) => {
      didClose = resolve
    })
    const close = h.runtime.closeTerminal.getMockImplementation()
    h.runtime.closeTerminal.mockImplementationOnce(async (handle) => {
      await close?.(handle)
      didClose()
    })
    await h.service.markDispatchResult({ runId: run.id, status: 'dispatched' })
    await waiting
    expect(h.store.listAutomationRuns()[0].status).toBe('dispatched')
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    h.runtime.getAgentStatusRowsForPane.mockReturnValue([done])
    finish({ satisfied: true })
    await closed
    await h.settle(automation.id)
    expect(h.store.listAutomationRuns()[0]).toMatchObject({
      status: 'completed',
      outputSnapshot: { content: 'Done' },
      usage: { status: 'unavailable' },
      terminalPaneKey: null
    })
    expect(h.panes.size).toBe(1)
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
    h.service.stop()
  })
})
