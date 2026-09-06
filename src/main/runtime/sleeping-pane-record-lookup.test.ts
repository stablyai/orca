import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { findSleepingAgentSessionRecord } from './sleeping-pane-record-lookup'

const LEAF = '11111111-1111-4111-8111-111111111111'

function record(paneKey: string, worktreeId: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1
  }
}

function session(records: Record<string, SleepingAgentSessionRecord>): WorkspaceSessionState {
  return { sleepingAgentSessionsByPaneKey: records } as unknown as WorkspaceSessionState
}

describe('findSleepingAgentSessionRecord', () => {
  it('finds the record in a non-local host partition', () => {
    const remote = record(`tab-9:${LEAF}`, 'wt-ssh')
    expect(
      findSleepingAgentSessionRecord(
        [session({}), null, session({ [`tab-9:${LEAF}`]: remote })],
        `tab-9:${LEAF}`
      )
    ).toBe(remote)
  })

  it('matches a reminted pane key by its stable leaf id', () => {
    const stored = record(`old-tab:${LEAF}`, 'wt-1')
    expect(
      findSleepingAgentSessionRecord([session({ [`old-tab:${LEAF}`]: stored })], `new-tab:${LEAF}`)
    ).toBe(stored)
  })

  it('returns undefined when nothing matches', () => {
    expect(
      findSleepingAgentSessionRecord(
        [session({ [`tab-1:${LEAF}`]: record(`tab-1:${LEAF}`, 'wt') })],
        'tab-2:other'
      )
    ).toBeUndefined()
  })

  it('tolerates partitions with no sleeping records', () => {
    expect(
      findSleepingAgentSessionRecord([{} as WorkspaceSessionState, undefined], `tab-1:${LEAF}`)
    ).toBeUndefined()
  })
})
