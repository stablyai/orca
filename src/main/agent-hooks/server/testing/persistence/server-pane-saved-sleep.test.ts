import { expect, it } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { PANE } from '../server.test-fixtures'
import { resumeStatusFromHookRow } from '../../../../runtime/terminal/stop/hook-status-resume-records'
import { liveResumeRecord } from '../../../../../shared/agent-session/lifecycle/resume/agent-resume-record-from-status'
import { agentEntryCompletionAt } from '../../../../../shared/agent-status/lifecycle/agent-completion-time'

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
          expect(agentEntryCompletionAt(row)).toBeNull()
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
