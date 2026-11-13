import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { useHelperFollowUpCli } from '../testing/helper-follow-up-cli.test-support'

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
    let hookRows: AgentStatusIpcPayload[] = []
    Object.defineProperty(h.runtime, 'getAgentStatusSnapshotFn', {
      configurable: true,
      value: () => hookRows
    })
    vi.spyOn(h.runtime, 'getTerminalHandleForPaneKey').mockImplementation((paneKey) =>
      paneKey === REOPENED_PANE && live.has('term_reopened') ? 'term_reopened' : null
    )
    vi.spyOn(h.runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      live.has(handle) ? REOPENED_PANE : null
    )
    vi.spyOn(h.runtime, 'isTerminalRunningAgent').mockImplementation(async (handle) =>
      live.has(handle)
    )
    const resume = vi
      .spyOn(h.runtime, 'resumeAgentSessionInWorkspace')
      .mockImplementation(async () => {
        live.add('term_reopened')
        return { ok: true, handle: 'term_reopened', paneKey: REOPENED_PANE, ptyId: 'pty' }
      })
    /** The reopened pane's agent reports its conversation. */
    const report = (row: Pick<AgentStatusIpcPayload, 'agentType' | 'providerSession'>) => {
      hookRows = [
        {
          state: 'working',
          prompt: '',
          paneKey: REOPENED_PANE,
          connectionId: null,
          receivedAt: 1,
          stateStartedAt: 1,
          ...row
        }
      ]
    }
    const resource = h.db.getWorkerTerminalResourceByOwner(helper.dispatchId)!
    return { helper, resource, resume, report }
  }

  const open = (address: string) => h.call('orchestration.partyOpen', { address })

  it('forgets an uncertain request once its conversation reports, so a later resume is a new one', async () => {
    const { resource, resume, report } = await closedHelper()
    const succeed = resume.getMockImplementation()!
    resume.mockImplementationOnce(async (...args) => {
      await succeed(...args)
      return { ok: false, reason: 'create_failed' }
    })
    await expect(open(resource.terminal_handle)).rejects.toThrow()
    report({ agentType: 'claude', providerSession: CONVERSATION })
    expect(await open(resource.terminal_handle)).toEqual({
      location: { kind: 'terminal', handle: 'term_reopened' }
    })
    vi.mocked(h.runtime.isTerminalRunningAgent).mockResolvedValue(false)
    await open(resource.terminal_handle)
    const [uncertainId, later] = resume.mock.calls.map(([, request]) => request.mutationId)
    expect(resume).toHaveBeenCalledTimes(2)
    expect(later).not.toBe(uncertainId)
  })
})
