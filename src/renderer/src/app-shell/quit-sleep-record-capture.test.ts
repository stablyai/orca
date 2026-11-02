import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { AppState } from '../store/types'
import { createQuitSleepRecordCapture } from './quit-sleep-record-capture'
import { createShutdownCheckpointPersist } from './shutdown-checkpoint-persist'

const RECORD: SleepingAgentSessionRecord = {
  paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
  worktreeId: 'wt-1',
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'session-1' },
  prompt: '',
  state: 'working',
  capturedAt: 1,
  updatedAt: 1
}

/** A window holding tab-1, whose quit capture records RECORD (and then finds it unchanged). */
function windowStore() {
  let records: AppState['sleepingAgentSessionsByPaneKey'] = {}
  const state = (): AppState =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the capture reads only these fields.
    ({
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
      sleepingAgentSessionsByPaneKey: records,
      captureAllSleepingAgentSessions: () => {
        records = { [RECORD.paneKey]: RECORD }
      }
    }) as unknown as AppState
  return { getState: state }
}

function persist(stage: (args: { sleepRecords?: SleepingAgentSessionRecord[] }) => void) {
  const capture = createQuitSleepRecordCapture(windowStore())
  return createShutdownCheckpointPersist({
    shouldCaptureSession: () => true,
    captureTerminalBuffers: vi.fn(),
    captureSleepingAgentSessions: capture.capture,
    onSleepRecordsStaged: capture.staged,
    buildSessionSnapshots: () => [],
    buildUiPatch: () => ({}),
    hasDirtyOpenFiles: () => false,
    isDegradableShutdownInProgress: () => false,
    stageBeforeUnloadSync: stage
  })
}

describe('the quit capture’s resume records in a layout-owner build', () => {
  it('sends the first capture’s records again on a stage retried after a failure', () => {
    const staged: (SleepingAgentSessionRecord[] | undefined)[] = []
    let fail = true
    const checkpoint = persist(({ sleepRecords }) => {
      staged.push(sleepRecords)
      if (fail) {
        throw new Error('stage failed')
      }
    })

    expect(() => checkpoint.run()).toThrow('stage failed')
    fail = false
    checkpoint.run()

    expect(staged).toEqual([[RECORD], [RECORD]])
  })

  it('sends nothing again once a stage carried them', () => {
    const staged: (SleepingAgentSessionRecord[] | undefined)[] = []
    const checkpoint = persist(({ sleepRecords }) => staged.push(sleepRecords))

    checkpoint.run()
    checkpoint.run()

    expect(staged).toEqual([[RECORD], undefined])
  })
})
