import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'
import { readWorkerDock, acknowledgeWorkerDock } from './worker-dock-read'
import { workerDockFailureSink } from './worker-dock-provider-failures'
import { createAgentStatusStore } from '../../../../shared/agent-status/store/agent-status-store'
import { createAgentChildWorkAdmission } from '../../../../shared/agent-status/child-work/agent-status-child-work-admission'
import { reconcileAgentChildWorkEvidence } from '../../../../shared/agent-status/child-work/agent-status-child-work-reconciliation'
import { makeStructuredAgentStatusSubject } from '../../../../shared/agent-status/contracts/agent-status-subject'

it.each(['agent', 'command'] as const)(
  'retains a failed provider %s through a new turn and restart until its exact Clear',
  (kind) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-provider-failure-'))
    const file = join(directory, 'orchestration.db')
    const session = '11111111-1111-4111-8111-111111111111'
    const party = `orca_session_id:${session}`
    let db = new OrchestrationDb(file)
    try {
      const parent = makeStructuredAgentStatusSubject(
        {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: '/folder',
          workspaceKind: 'folder'
        },
        session
      )
      const store = createAgentStatusStore({ epoch: 'provider-retention', mode: 'authority' })
      store.applyMutation({ parent: { subject: parent } })
      let identity = 0
      const admission = createAgentChildWorkAdmission(store, {
        mintChildWorkId: () => `child-${++identity}`
      })
      const sink = workerDockFailureSink(
        {
          publish: () => {},
          forget: () => {},
          publishChildWork: (_subject, evidence, provider) =>
            reconcileAgentChildWorkEvidence({ store, admission, parent, evidence, provider })
        },
        { getOrchestrationDb: () => db }
      )!
      const fail = (runId: string) => {
        const at = runId === 'first' ? 100 : 400
        sink.publishChildWork!(
          parent,
          [
            {
              type: 'live',
              restart: true,
              observedAt: at,
              child: {
                handle: { idKind: 'task_id', id: 'shell-7', runId },
                kind,
                residency: 'background',
                state: 'working',
                description: 'Verify the journal',
                stoppable: true
              }
            }
          ],
          'claude'
        )
        sink.publishChildWork!(
          parent,
          [
            {
              type: 'ended',
              observedAt: at + 100,
              handle: { idKind: 'task_id', id: 'shell-7', runId },
              outcome: 'failed',
              lastMessage: 'Verification exited with code 1.'
            }
          ],
          'claude'
        )
      }
      fail('first')
      const failure = readWorkerDock(db, { party, direction: 'around' }).rows[0]
      expect(failure).toMatchObject({
        kind,
        state: 'failed',
        reason: 'Verification exited with code 1.'
      })
      sink.publishChildWork!(parent, [{ type: 'turn-started', observedAt: 300 }], 'claude')
      db.close()
      db = new OrchestrationDb(file)
      expect(readWorkerDock(db, { party, direction: 'around' }).rows).toEqual([failure])
      fail('second')
      acknowledgeWorkerDock(db, {
        party,
        acknowledged: true,
        settlements: [{ dispatchId: failure.dispatchId, settlement: failure.settlement! }]
      })
      const remaining = readWorkerDock(db, { party, direction: 'around' }).rows
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).not.toBe(failure.id)
      acknowledgeWorkerDock(db, {
        party,
        acknowledged: true,
        settlements: [{ dispatchId: remaining[0].dispatchId, settlement: remaining[0].settlement! }]
      })
      db.close()
      db = new OrchestrationDb(file)
      expect(readWorkerDock(db, { party, direction: 'around' }).identities).toEqual([])
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

it('never keeps a failed foreground command, which only its transcript tool row shows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-provider-failure-'))
  const db = new OrchestrationDb(join(directory, 'orchestration.db'))
  const session = '22222222-2222-4222-8222-222222222222'
  try {
    const parent = makeStructuredAgentStatusSubject(
      {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: '/folder',
        workspaceKind: 'folder'
      },
      session
    )
    const store = createAgentStatusStore({ epoch: 'provider-retention', mode: 'authority' })
    store.applyMutation({ parent: { subject: parent } })
    let identity = 0
    const admission = createAgentChildWorkAdmission(store, {
      mintChildWorkId: () => `child-${++identity}`
    })
    const sink = workerDockFailureSink(
      {
        publish: () => {},
        forget: () => {},
        publishChildWork: (_subject, evidence, provider) =>
          reconcileAgentChildWorkEvidence({ store, admission, parent, evidence, provider })
      },
      { getOrchestrationDb: () => db }
    )!
    sink.publishChildWork!(
      parent,
      [
        {
          type: 'live',
          observedAt: 100,
          child: {
            handle: { idKind: 'task_id', id: 'shell-fg', runId: 'run' },
            kind: 'command',
            residency: 'foreground',
            state: 'working',
            description: 'grep -r missing .',
            stoppable: false
          }
        },
        {
          type: 'ended',
          observedAt: 200,
          handle: { idKind: 'task_id', id: 'shell-fg', runId: 'run' },
          outcome: 'failed'
        }
      ],
      'claude'
    )
    expect(
      readWorkerDock(db, { party: `orca_session_id:${session}`, direction: 'around' }).identities
    ).toEqual([])
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
