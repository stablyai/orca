import { describe, expect, it, vi } from 'vitest'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import type { AutomationRun } from '../../shared/automations-types'
import type { HeadlessAutomationDispatchLaunch } from './headless-dispatch'
import { runHeadlessAutomationDispatch } from './headless-dispatch-runner'

function fixture(launch: HeadlessAutomationDispatchLaunch) {
  const state = buildProfileStateCutoverFixture('/fixture')
  const automation = { ...state.automations[0], precheck: null }
  const run: AutomationRun = {
    ...state.automationRuns[0],
    automationId: automation.id,
    status: 'dispatching'
  }
  const dispatched: AutomationRun = { ...run, ...launch, status: 'dispatched' }
  return {
    automation,
    run,
    target: { ok: true as const, cwd: state.repos[0].path, repo: state.repos[0] },
    dispatcher: vi.fn(async () => launch),
    runs: {
      createRun: vi.fn(async () => run),
      updateRun: vi.fn(async () => dispatched),
      repeatSkip: vi.fn(async () => null),
      advanceNextRun: vi.fn(async () => automation)
    },
    runPrecheck: vi.fn(async () => null),
    markDispatchResult: vi.fn(async () => dispatched),
    watchRun: vi.fn()
  }
}

const terminal = {
  workspaceId: 'launched-workspace',
  terminalSessionId: 'launched-tab',
  terminalPaneKey: 'launched-pane',
  terminalPtyId: 'launched-pty'
}

describe('headless automation observation during persistence', () => {
  it('handles an early completion rejection while the dispatched write is stalled', async () => {
    const completion = Promise.withResolvers<never>()
    const acknowledgement = Promise.withResolvers<AutomationRun>()
    const context = fixture({ ...terminal, completion: completion.promise })
    context.runs.updateRun.mockReturnValueOnce(acknowledgement.promise)
    const pending = runHeadlessAutomationDispatch(context)
    await vi.waitFor(() => expect(context.runs.updateRun).toHaveBeenCalledOnce())
    completion.reject(new Error('agent exited early'))
    await vi.waitFor(() =>
      expect(context.markDispatchResult).toHaveBeenCalledWith({
        runId: context.run.id,
        status: 'dispatch_failed',
        ...terminal,
        workspaceDisplayName: null,
        error: 'agent exited early'
      })
    )
    acknowledgement.resolve({ ...context.run, ...terminal, status: 'dispatched' })
    await pending
  })

  it('starts terminal observation even when the dispatched write fails after launch', async () => {
    const context = fixture(terminal)
    const failure = new Error('disk full')
    context.runs.updateRun.mockRejectedValueOnce(failure)
    await expect(runHeadlessAutomationDispatch(context)).rejects.toBe(failure)
    expect(context.watchRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...terminal,
        status: 'dispatched'
      })
    )
    expect(context.runs.updateRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...terminal,
        status: 'dispatched'
      })
    )
  })

  it('keeps receiving completion after the launched run fails to persist', async () => {
    const completion = Promise.withResolvers<{ status: 'completed' }>()
    const context = fixture({ ...terminal, completion: completion.promise })
    context.runs.updateRun.mockRejectedValueOnce(new Error('writer unavailable'))
    await expect(runHeadlessAutomationDispatch(context)).rejects.toThrow('writer unavailable')
    completion.resolve({ status: 'completed' })
    await vi.waitFor(() =>
      expect(context.markDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({ ...terminal, status: 'completed' })
      )
    )
    expect(context.runs.updateRun).toHaveBeenCalledOnce()
  })

  it('records an actual launch rejection as dispatch failure', async () => {
    const context = fixture(terminal)
    context.dispatcher.mockRejectedValueOnce(new Error('shell unavailable'))
    await runHeadlessAutomationDispatch(context)
    expect(context.runs.updateRun).toHaveBeenCalledExactlyOnceWith({
      runId: context.run.id,
      status: 'dispatch_failed',
      workspaceId: context.automation.workspaceId,
      error: 'shell unavailable'
    })
    expect(context.watchRun).not.toHaveBeenCalled()
  })
})
