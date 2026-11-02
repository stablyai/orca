import { describe, expect, it, vi } from 'vitest'
import { useHelperFollowUpCli } from './helper-follow-up-cli.test-support'
import { chooseWorkerFollowUpPlacement } from './worker-follow-up-choice'

const CONVERSATION = { key: 'session_id', id: 'fixture-conversation' } as const
const REOPENED_PANE = 'tab_reopened:leaf'

describe('opening a terminal worker Orca closed', () => {
  const { h, panes, pair, success } = useHelperFollowUpCli()

  /** A finished helper whose pane recorded `conversation`, then closed by Orca. */
  async function closedHelper(recorded = true) {
    const { helper } = await pair()
    if (recorded) {
      vi.mocked(h.runtime.getExactWorkerProviderSession).mockReturnValue({
        paneKey: panes.get('term_helper')!,
        agent: 'claude',
        processIncarnation: 'process:term_helper',
        providerSession: CONVERSATION,
        observedAt: 1
      })
    }
    await success('worker-release', '--dispatch', helper.dispatchId)
    const live = new Set<string>()
    vi.spyOn(h.runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      live.has(handle) ? REOPENED_PANE : null
    )
    const resume = vi
      .spyOn(h.runtime, 'resumeAgentSessionInWorkspace')
      .mockImplementation(async () => {
        live.add('term_reopened')
        return { ok: true, handle: 'term_reopened', paneKey: REOPENED_PANE, ptyId: 'pty' }
      })
    const resource = h.db.getWorkerTerminalResourceByOwner(helper.dispatchId)!
    return { helper, resource, resume }
  }

  const open = (address: string) => h.call('orchestration.partyOpen', { address })
  const locate = (address: string) => h.call('orchestration.partyLocation', { address })

  it('resumes its conversation in a new terminal, and a second click reuses it', async () => {
    const { resource, resume } = await closedHelper()
    for (let click = 0; click < 2; click++) {
      expect(await open(resource.terminal_handle)).toEqual({
        location: { kind: 'terminal', handle: 'term_reopened' }
      })
    }
    expect(resume).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledWith(
      resource.worktree_id,
      expect.objectContaining({
        agent: 'claude',
        providerSession: CONVERSATION,
        captureHostId: 'local'
      })
    )
  })

  it('keeps the lookup answer without a saved conversation', async () => {
    const { resource, resume } = await closedHelper(false)
    expect(await open(resource.terminal_handle)).toEqual(await locate(resource.terminal_handle))
    expect(resume).not.toHaveBeenCalled()
  })

  it('keeps the lookup answer when the conversation was recorded on another host', async () => {
    const { resource, resume } = await closedHelper()
    resume.mockResolvedValue({ ok: false, reason: 'no_resume_command' })
    expect(await open(resource.terminal_handle)).toEqual(await locate(resource.terminal_handle))
  })

  it('sends a later follow-up into the reopened terminal, not a second one', async () => {
    const { helper, resource, resume } = await closedHelper()
    await open(resource.terminal_handle)
    // The resumed agent's hook row, which names the conversation in its pane.
    Object.defineProperty(h.runtime, 'getAgentStatusSnapshotFn', {
      configurable: true,
      // SAFETY: placement reads only the agent, pane and conversation of a status row.
      value: () => [
        { agentType: 'claude', paneKey: REOPENED_PANE, providerSession: CONVERSATION } as never
      ]
    })
    vi.spyOn(h.runtime, 'getTerminalHandleForPaneKey').mockImplementation((paneKey) =>
      paneKey === REOPENED_PANE ? 'term_reopened' : null
    )
    const placement = await chooseWorkerFollowUpPlacement(
      h.runtime,
      h.db,
      h.db.getDispatchContextById(helper.dispatchId)!,
      resource,
      { admit: () => {}, requested: () => {} }
    )
    expect(placement).toMatchObject({ delivery: 'follow_up', terminal: 'term_reopened' })
    expect(resume).toHaveBeenCalledOnce()
  })

  it('retries an uncertain resume as the same request, so it reconciles the pane it may have started', async () => {
    const { resource, resume } = await closedHelper()
    const succeed = resume.getMockImplementation()!
    resume.mockResolvedValueOnce({ ok: false, reason: 'create_failed' })
    await expect(open(resource.terminal_handle)).rejects.toThrow()
    resume.mockImplementation(succeed)
    expect(await open(resource.terminal_handle)).toEqual({
      location: { kind: 'terminal', handle: 'term_reopened' }
    })
    const [first, second] = resume.mock.calls.map(([, request]) => request.mutationId)
    expect(second).toBe(first)
  })
})
