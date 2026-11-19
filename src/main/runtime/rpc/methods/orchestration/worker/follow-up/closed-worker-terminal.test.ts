import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { useHelperFollowUpCli } from '../testing/helper-follow-up-cli.test-support'
import type { AgentProviderSessionMetadata } from '../../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'

import { AgentHookServer } from '../../../../../../agent-hooks/server/agent-hook-server'
import { agentHookRuntimeDeps } from '../../../../../../agent-hooks/runtime/agent-hook-runtime-deps'
import {
  captureReportedWorkerResumeSession,
  watchMovedWorkerResumeSessions
} from './worker-resume-session-capture'

const CONVERSATION = { key: 'session_id', id: 'fixture-conversation' } as const
const REOPENED_PANE = 'tab_reopened:leaf'

describe('opening a terminal worker Orca closed', () => {
  const { h, panes, pair, success } = useHelperFollowUpCli()

  /** A finished helper whose pane recorded `conversation`, then closed by Orca. */
  async function closedHelper(
    recorded = true,
    providerSession: AgentProviderSessionMetadata = CONVERSATION
  ) {
    const { helper } = await pair()
    if (recorded) {
      vi.mocked(h.runtime.getExactWorkerProviderSession).mockReturnValue({
        paneKey: panes.get('term_helper')!,
        agent: 'claude',
        processIncarnation: 'process:term_helper',
        providerSession,
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

  it('keeps the held worker conversation current across new sessions and reconnects', async () => {
    const { helper, worker } = await pair()
    const paneKey = panes.get('term_helper')!
    const server = new AgentHookServer()
    const deps = agentHookRuntimeDeps(server, { read: () => ({ kind: 'unobserved' }) }, () => ({}))
    const read = () => {
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
    }
    const stop = deps.subscribeAgentProviderSessionChanges(
      watchMovedWorkerResumeSessions({ getExactWorkerProviderSession: read }, () => h.db)
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
    try {
      report('session-a', 'working', 'First task')
      expect(saved()).toEqual({
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'session-a' },
        connectionId: null
      })
      report('session-a', 'done', 'Finished first task')
      expect(saved().providerSession.id).toBe('session-a')

      report('session-b', 'working', 'New conversation')
      expect(saved().providerSession.id).toBe('session-b')
      server.dropStatusEntry(paneKey, { preserveResumeIdentity: false })
      report('session-b', 'working', 'Reconnected')
      expect(saved().providerSession.id).toBe('session-b')
      expect(h.db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.resume_session).toBeNull()
    } finally {
      stop()
      server.stop()
    }
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

  it('reopens with the recipe the worker launched with after its agent exited (#43875)', async () => {
    const { helper } = await pair()
    const recipe = { agentArgs: "--dangerously-skip-permissions --model 'M'", agentEnv: {} }
    const session = {
      paneKey: panes.get('term_helper')!,
      agent: 'claude',
      processIncarnation: 'process:term_helper',
      providerSession: CONVERSATION,
      observedAt: 1
    }
    const capture = vi.mocked(h.runtime.getExactWorkerProviderSession)
    capture.mockReturnValue({ ...session, launchConfig: recipe })
    captureReportedWorkerResumeSession(h.runtime, h.db, helper.dispatchId)
    // Its agent exited, so release reads the same conversation without a held launch.
    capture.mockReturnValue(session)
    await success('worker-release', '--dispatch', helper.dispatchId)
    const resource = h.db.getWorkerTerminalResourceByOwner(helper.dispatchId)!
    const resume = vi
      .spyOn(h.runtime, 'resumeAgentSessionInWorkspace')
      .mockResolvedValue({ ok: true, handle: 'term_reopened', paneKey: REOPENED_PANE, ptyId: 'p' })
    await open(resource.terminal_handle)
    expect(resume.mock.calls[0]?.[1].launchConfig).toEqual(recipe)
  })

  describe('its conversation log, for a terminal that is gone for good', () => {
    const transcript = (dispatch: string) => h.call('orchestration.workerTranscript', { dispatch })
    const LOG = '/home/me/.claude/projects/fixture/conversation.jsonl'

    it('names the log its agent reported, by the Dispatch a row holds', async () => {
      const { helper } = await closedHelper(true, { ...CONVERSATION, transcriptPath: LOG })
      expect(await transcript(helper.dispatchId)).toEqual({
        transcript: { agent: 'claude', path: LOG }
      })
    })

    it('has none when the agent reported no log, or no conversation at all', async () => {
      const { helper } = await closedHelper()
      expect(await transcript(helper.dispatchId)).toEqual({ transcript: null })
      expect(await transcript('ctx_unknown')).toEqual({ transcript: null })
    })
  })
})
