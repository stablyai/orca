import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { markResumedRecordLive } from './window-wake-sleep-record'

const PANE_KEY = 'tab-1:leaf-1'
const RESUMED: SleepingAgentSessionRecord = {
  paneKey: PANE_KEY,
  tabId: 'tab-1',
  worktreeId: 'repo::/work',
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'conv-1' },
  prompt: '',
  state: 'done',
  capturedAt: 1,
  updatedAt: 1,
  origin: 'worktree-sleep'
}

async function markedRecord(stored: SleepingAgentSessionRecord) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the edit reads only the records.
  let session = {
    sleepingAgentSessionsByPaneKey: { [PANE_KEY]: stored }
  } as unknown as WorkspaceSessionState
  await markResumedRecordLive(
    async (edit) => {
      session = edit(session) ?? session
    },
    PANE_KEY,
    RESUMED
  )
  return session.sleepingAgentSessionsByPaneKey?.[PANE_KEY]
}

describe('marking a resumed pane record live', () => {
  it('turns the record the start resumed from into a running agent’s', async () => {
    expect(await markedRecord(RESUMED)).toMatchObject({ origin: 'live', capturedAt: 1 })
  })

  it('leaves a sleep of the pane captured after the start', async () => {
    const sleptAgain = { ...RESUMED, capturedAt: 2, updatedAt: 2 }
    expect(await markedRecord(sleptAgain)).toEqual(sleptAgain)
  })
})
