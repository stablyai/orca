import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { captureWorktreeSleepResumeRecords } from '../../../../runtime/terminal/stop/worktree-sleep-resume-records'
import { AgentHookServer } from '../../agent-hook-server'
import { PANE } from '../server.test-fixtures'
import { resumeStatusFromHookRow } from '../../../../runtime/terminal/stop/hook-status-resume-records'
import { liveResumeRecord } from '../../../../../shared/agent-session/lifecycle/resume/agent-resume-record-from-status'
import { agentEntryCompletionAt } from '../../../../../shared/agent-status/lifecycle/agent-completion-time'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000)
})
afterEach(() => vi.useRealTimers())

it.each(['claude', 'codex'] as const)(
  'settles %s saved-only turns without inventing a completion',
  (agent) => {
    for (const turn of ['working', 'waiting', 'boundary', 'interrupted'] as const) {
      const state = turn === 'working' || turn === 'waiting' ? turn : 'done'
      const status = resumeStatusFromHookRow(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agentType: agent,
          connectionId: null,
          receivedAt: 100,
          stateStartedAt: 100,
          providerSession: { key: 'session_id', id: `${agent}-session` },
          state,
          prompt: '',
          ...(turn === 'boundary' ? { sessionBoundary: true } : {}),
          ...(turn === 'interrupted' ? { interrupted: true } : {}),
          mainAgent: {
            state,
            stateStartedAt: 100,
            ...(turn === 'interrupted' ? { outcome: 'cancellation' } : {})
          }
        },
        undefined
      )!
      const saved = liveResumeRecord({
        entry: status,
        retainsResumableIdentity: state === 'done',
        worktreeIdOf: () => 'wt-1',
        tabOf: () => ({ id: 'tab-1' }),
        capturedAt: 100
      })!
      const server = new AgentHookServer()
      server.setTerminalPaneLifecycle({
        readSavedRecord: () => saved,
        ownsProcess: () => true,
        isStopping: () => true,
        isReversibleStop: () => true,
        isPlaced: () => true
      })
      try {
        expect(server.settleTerminalPaneSleep(PANE, 'pty', 'birth')).toBe(true)
        const row = server.getStatusSnapshotForPane(PANE)[0]!
        expect(row).toMatchObject({ state: 'done', paneSleep: { ptyId: 'pty' } })
        if (turn === 'boundary') {
          expect(row.sessionBoundary).toBe(true)
          expect(agentEntryCompletionAt({ ...row, stateHistory: [] })).toBeNull()
        } else {
          expect(row).toMatchObject({
            interrupted: true,
            mainAgent: { state: 'done', outcome: 'cancellation' }
          })
          expect(row.sessionBoundary).not.toBe(true)
          server.retireSleepingPaneOnSpawn(PANE, {
            agentType: agent,
            providerSession: { key: 'session_id', id: `${agent}-session` }
          })
          expect(server.settleTerminalPaneSleep(PANE, 'pty-2', 'birth-2')).toBe(true)
          expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({ interrupted: true })
        }
      } finally {
        server.stop()
      }
    }
  }
)

it.each(['claude', 'codex'] as const)(
  'recovers saved %s Interrupted before hooks and keeps it until a new turn',
  async (agent) => {
    for (const origin of ['live', 'worktree-sleep'] as const) {
      let saved: SleepingAgentSessionRecord = {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agent,
        providerSession: { key: 'session_id', id: `${agent}-saved-session` },
        prompt: 'Interrupted task',
        state: 'done',
        interrupted: true,
        mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 100 },
        capturedAt: 100,
        updatedAt: 100,
        origin,
        connectionId: null
      }
      let stopping = false
      const server = new AgentHookServer()
      server.setTerminalPaneLifecycle({
        readSavedRecord: () => saved,
        ownsProcess: () => true,
        isStopping: () => stopping,
        isReversibleStop: () => stopping,
        isPlaced: () => true
      })
      const read = () => server.getStatusSnapshotForPane(PANE)[0]
      const launch = () =>
        server.recordLaunchResumeIdentity({
          paneKey: PANE,
          worktreeId: 'wt-1',
          agentType: agent,
          providerSession: saved.providerSession,
          launchedAt: 1_000
        })
      const publish = (newTurn: boolean) =>
        server.ingestRemote(
          {
            paneKey: PANE,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            source: agent,
            hookEventName: newTurn ? 'UserPromptSubmit' : 'SessionStart',
            hasExplicitPrompt: newTurn,
            providerSession: saved.providerSession,
            payload: {
              agentType: agent,
              state: newTurn ? 'working' : 'done',
              prompt: newTurn ? 'Next task' : '',
              ...(newTurn ? {} : { sessionBoundary: true })
            }
          },
          null
        )
      try {
        launch()
        expect(read()).toMatchObject({
          state: 'done',
          interrupted: true,
          mainAgent: { state: 'done', outcome: 'cancellation' }
        })
        publish(false)
        expect(read()).toMatchObject({ state: 'done', interrupted: true })
        server.dropStatusEntry(PANE, { preserveResumeIdentity: false })
        expect(read()).toBeUndefined()
        stopping = true
        expect(server.settleTerminalPaneSleep(PANE, 'pty', 'birth')).toBe(true)
        stopping = false
        const capture = await captureWorktreeSleepResumeRecords({
          worktreeId: 'wt-1',
          paneKeysByPtyId: new Map([['pty', [PANE]]]),
          launchByPtyId: new Map(),
          readRowsForPane: (paneKey) => server.getStatusSnapshotForPane(paneKey),
          checkAgentPresence: null,
          capturedAt: 1_000
        })
        saved = capture.get('pty')!.records[0]!
        expect(saved).toMatchObject({
          origin: 'worktree-sleep',
          state: 'done',
          interrupted: true,
          providerSession: { key: 'session_id', id: `${agent}-saved-session` }
        })
        server.dropStatusEntry(PANE, { preserveResumeIdentity: false })
        expect(server.paneAgentIdentity(PANE)).toMatchObject({
          ended: false,
          status: { state: 'done', interrupted: true }
        })
        server.retireSleepingPaneOnSpawn(PANE, {
          agentType: agent,
          providerSession: saved.providerSession
        })
        launch()
        publish(false)
        stopping = true
        expect(server.settleTerminalPaneSleep(PANE, 'pty-2', 'birth-2')).toBe(true)
        stopping = false
        expect(read()).toMatchObject({ state: 'done', interrupted: true })
        server.retireSleepingPaneOnSpawn(PANE, {
          agentType: agent,
          providerSession: saved.providerSession
        })
        publish(true)
        expect(read()).toMatchObject({ state: 'working', prompt: 'Next task' })
        expect(read()?.interrupted).not.toBe(true)
      } finally {
        server.stop()
      }
    }
  }
)

it('does not recover a saved Interrupted turn after its conversation exited', async () => {
  const saved: SleepingAgentSessionRecord = {
    paneKey: PANE,
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'quit-session' },
    prompt: 'Interrupted task',
    state: 'done',
    interrupted: true,
    capturedAt: 100,
    updatedAt: 100,
    origin: 'worktree-sleep'
  }
  const server = new AgentHookServer()
  server.setTerminalPaneLifecycle({
    readSavedRecord: () => saved,
    ownsProcess: () => true,
    isStopping: () => false,
    isReversibleStop: () => false,
    isPlaced: () => true,
    confirmShellAlone: async () => true
  })
  try {
    server.retireProcessAuthority(PANE, { confirmedExit: true })
    await vi.waitFor(() => expect(server.paneAgentIdentity(PANE)?.ended).toBe(true))
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      worktreeId: 'wt-1',
      agentType: 'codex',
      providerSession: saved.providerSession,
      launchedAt: 1_001
    })
    expect(server.getPublicStatusSnapshotForPane(PANE)).toEqual([])
    expect(server.paneAgentIdentity(PANE)?.status.interrupted).not.toBe(true)
  } finally {
    server.stop()
  }
})
