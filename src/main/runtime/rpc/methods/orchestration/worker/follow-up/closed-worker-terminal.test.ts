import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { useHelperFollowUpCli } from '../testing/helper-follow-up-cli.test-support'
import { chooseWorkerFollowUpPlacement } from './worker-follow-up-choice'
import { agentProviderSessionsEqual } from '../../../../../../../shared/agent-session/lifecycle/agent-session-resume'

import { AgentHookServer } from '../../../../../../agent-hooks/server/agent-hook-server'
import { agentHookRuntimeDeps } from '../../../../../../agent-hooks/runtime/agent-hook-runtime-deps'
import { watchMovedWorkerResumeSessions } from './worker-resume-session-capture'

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
    Object.defineProperty(h.runtime, 'getAgentProviderSessionRowsForSessionFn', {
      configurable: true,
      value: (agent: string, session: AgentStatusIpcPayload['providerSession']) =>
        hookRows.filter(
          (row) =>
            row.agentType === agent &&
            agentProviderSessionsEqual(agent, row.providerSession, session)
        )
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

  it('keeps a held worker conversation current without capturing equal status reports', async () => {
    const { helper, worker } = await pair()
    const paneKey = panes.get('term_helper')!
    const server = new AgentHookServer()
    const deps = agentHookRuntimeDeps(server, { read: () => ({ kind: 'unobserved' }) }, () => ({}))
    const read = vi.fn(() => {
      const row = deps.getAgentProviderSessionRowsForPane(paneKey)[0]
      return row?.providerSession
        ? {
            paneKey,
            agent: 'codex' as const,
            providerSession: row.providerSession,
            processIncarnation: 'process:term_helper',
            observedAt: 1,
            connectionId: null
          }
        : null
    })
    const getDb = vi.fn(() => h.db)
    const stop = deps.subscribeAgentProviderSessionChanges(
      watchMovedWorkerResumeSessions({ getExactWorkerProviderSession: read }, getDb)
    )
    const report = (id: string, state: 'working' | 'done', prompt: string) =>
      server.ingestRemote(
        {
          paneKey,
          worktreeId: 'repo::worktree',
          providerSession: { key: 'session_id', id },
          payload: { state, prompt, agentType: 'codex' }
        },
        null
      )
    const saved = () =>
      JSON.parse(h.db.getWorkerTerminalResourceByOwner(helper.dispatchId)!.resume_session!)
    const fleetReads = vi.spyOn(server, 'getStatusSnapshot')
    try {
      report('session-a', 'working', 'First task')
      expect(saved()).toEqual({
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'session-a' },
        connectionId: null
      })
      read.mockClear()
      getDb.mockClear()
      for (let index = 0; index < 100; index++) {
        report('session-a', index % 2 === 0 ? 'done' : 'working', `Progress ${index}`)
      }
      expect(read).not.toHaveBeenCalled()
      expect(getDb).not.toHaveBeenCalled()
      expect(fleetReads).not.toHaveBeenCalled()
      expect(saved().providerSession.id).toBe('session-a')

      report('session-b', 'working', 'New conversation')
      expect(read).toHaveBeenCalledOnce()
      expect(saved().providerSession.id).toBe('session-b')
      server.dropStatusEntry(paneKey, { preserveResumeIdentity: false })
      report('session-b', 'working', 'Reconnected')
      expect(read).toHaveBeenCalledTimes(2)
      expect(saved().providerSession.id).toBe('session-b')
      expect(h.db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.resume_session).toBeNull()
      expect(fleetReads).not.toHaveBeenCalled()
    } finally {
      stop()
      server.stop()
    }
  })

  it('resumes its conversation in a new terminal, and a click after it reports reuses it', async () => {
    const { resource, resume, report } = await closedHelper()
    for (let click = 0; click < 2; click++) {
      expect(await open(resource.terminal_handle)).toEqual({
        location: { kind: 'terminal', handle: 'term_reopened' }
      })
      report({ agentType: 'claude', providerSession: CONVERSATION })
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

  it('sends a later follow-up into the reopened terminal, not a second one', async () => {
    const { helper, resource, resume, report } = await closedHelper()
    await open(resource.terminal_handle)
    report({ agentType: 'claude', providerSession: CONVERSATION })
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
