import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { describe, expect, it } from 'vitest'
import { workerTabLineageAtLaunch } from './worker-tab-stamp-at-launch'

const task = {
  id: 'task-1',
  spec: 'Fix the flaky test',
  task_title: 'Fix flaky test',
  display_name: null
}

describe('workerTabLineageAtLaunch', () => {
  it('names the Run coordinator as parent and coordinator for a direct worker', () => {
    const lineage = workerTabLineageAtLaunch({
      run: {
        id: 'run-1',
        coordinator_pane_key: 'coord-tab:coord-leaf',
        coordinator_orca_session_id: null
      },
      task,
      dispatchId: 'dispatch-1'
    })
    expect(lineage).toEqual({
      runId: 'run-1',
      dispatchId: 'dispatch-1',
      taskId: 'task-1',
      taskTitle: 'Fix flaky test',
      parent: { kind: 'pane', paneKey: 'coord-tab:coord-leaf' },
      coordinator: { kind: 'pane', paneKey: 'coord-tab:coord-leaf' }
    })
  })

  it("parents a helper on its creator while keeping the Run's coordinator", () => {
    const lineage = workerTabLineageAtLaunch({
      run: {
        id: 'run-1',
        coordinator_pane_key: 'coord-tab:coord-leaf',
        coordinator_orca_session_id: null
      },
      task,
      dispatchId: 'dispatch-2',
      creator: { assignee_pane_key: 'helper-tab:helper-leaf', assignee_orca_session_id: null }
    })
    expect(lineage?.parent).toEqual({ kind: 'pane', paneKey: 'helper-tab:helper-leaf' })
    expect(lineage?.coordinator).toEqual({ kind: 'pane', paneKey: 'coord-tab:coord-leaf' })
  })

  it('names a native-chat coordinator by its session, never by the helper', () => {
    const lineage = workerTabLineageAtLaunch({
      run: {
        id: 'run-1',
        coordinator_pane_key: null,
        coordinator_orca_session_id: testOrcaSessionId('00000000-0000-4000-8000-000000000001')
      },
      task,
      dispatchId: 'dispatch-3',
      creator: {
        assignee_pane_key: null,
        assignee_orca_session_id: testOrcaSessionId('00000000-0000-4000-8000-000000000002')
      }
    })
    expect(lineage?.coordinator).toEqual({
      kind: 'session',
      lineageRootSessionId: '00000000-0000-4000-8000-000000000001'
    })
    expect(lineage?.parent).toEqual({
      kind: 'session',
      lineageRootSessionId: '00000000-0000-4000-8000-000000000002'
    })
  })

  it('stamps nothing when the Run has neither a coordinator pane nor a session', () => {
    expect(
      workerTabLineageAtLaunch({
        run: { id: 'run-1', coordinator_pane_key: null, coordinator_orca_session_id: null },
        task,
        dispatchId: 'dispatch-4'
      })
    ).toBeNull()
  })
})
