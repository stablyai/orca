import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { collectResumableSleptPanes } from './resumable-slept-pane-listing'

const LEAF = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = `tab-1:${LEAF}`

function record(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 42,
    terminalTitle: 'coordinator',
    origin: 'worktree-sleep',
    ...overrides
  }
}

function session(...records: SleepingAgentSessionRecord[]): WorkspaceSessionState {
  return {
    sleepingAgentSessionsByPaneKey: Object.fromEntries(records.map((r) => [r.paneKey, r]))
  } as unknown as WorkspaceSessionState
}

const anyWorktree = {
  targetWorktreeId: null,
  matchesTargetWorktree: (a: string, b: string) => a === b
}

describe('collectResumableSleptPanes', () => {
  it('reports a slept pane with its tab, leaf and agent', () => {
    expect(collectResumableSleptPanes([session(record())], anyWorktree)).toEqual([
      {
        paneKey: PANE_KEY,
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: LEAF,
        title: 'coordinator',
        agent: 'claude',
        lastOutputAt: 42
      }
    ])
  })

  it('includes a quit capture, which is also resumable', () => {
    expect(
      collectResumableSleptPanes([session(record({ origin: 'quit' }))], anyWorktree)
    ).toHaveLength(1)
  })

  it('excludes a live resume anchor, which describes a pane that never went away', () => {
    expect(collectResumableSleptPanes([session(record({ origin: 'live' }))], anyWorktree)).toEqual(
      []
    )
  })

  it('excludes a legacy originless record', () => {
    const legacy = record()
    delete legacy.origin
    expect(collectResumableSleptPanes([session(legacy)], anyWorktree)).toEqual([])
  })

  it('excludes a record whose provider session cannot build a resume command', () => {
    expect(
      collectResumableSleptPanes(
        [session(record({ providerSession: { key: 'conversation_id', id: 'x' } }))],
        anyWorktree
      )
    ).toEqual([])
  })

  it('filters to the requested worktree', () => {
    const other = record({ paneKey: `tab-2:${LEAF}`, tabId: 'tab-2', worktreeId: 'wt-2' })
    expect(
      collectResumableSleptPanes([session(record(), other)], {
        targetWorktreeId: 'wt-2',
        matchesTargetWorktree: (a, b) => a === b
      }).map((pane) => pane.worktreeId)
    ).toEqual(['wt-2'])
  })

  it('searches every host partition', () => {
    const remote = record({ paneKey: `tab-9:${LEAF}`, tabId: 'tab-9', worktreeId: 'wt-ssh' })
    expect(
      collectResumableSleptPanes([session(), null, session(remote)], anyWorktree)
    ).toHaveLength(1)
  })

  it('falls back to the pane key tab when the record has no tab id', () => {
    const noTab = record()
    delete noTab.tabId
    expect(collectResumableSleptPanes([session(noTab)], anyWorktree)[0]?.tabId).toBe('tab-1')
  })
})
