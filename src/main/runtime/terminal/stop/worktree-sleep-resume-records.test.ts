import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentProcessVerdict } from '../../../../shared/agent-status/process/agent-process-presence'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { captureWorktreeSleepResumeRecords } from './worktree-sleep-resume-records'

const WORKTREE_ID = 'repo-1::/work/feature'
const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const PTY_ID = 'pty-1'

function savedLiveCheckpoint(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'claude-session-1' },
    prompt: 'fix the flaky test',
    state: 'done',
    capturedAt: 100,
    updatedAt: 100,
    origin: 'live',
    connectionId: null,
    ...overrides
  }
}

// An idle agent whose hook row is gone: the hook store has no row for its pane.
function captureWithoutHookRow(
  saved: SleepingAgentSessionRecord | undefined,
  paneAgent: TerminalAgent | null = null,
  presence: AgentProcessVerdict | null = null
) {
  return captureWorktreeSleepResumeRecords({
    worktreeId: WORKTREE_ID,
    paneKeysByPtyId: new Map([[PTY_ID, [PANE_KEY]]]),
    launchByPtyId: new Map([[PTY_ID, undefined]]),
    agentByPtyId: new Map([[PTY_ID, paneAgent]]),
    readRows: () => [],
    readSavedRecord: (paneKey) => (paneKey === PANE_KEY ? saved : undefined),
    checkAgentPresence: async () => presence,
    capturedAt: 5000
  })
}

describe('sleeping a pane whose hook row is gone', () => {
  it('records the saved live checkpoint as a tab-open resume', async () => {
    const capture = await captureWithoutHookRow(savedLiveCheckpoint(), 'claude')

    expect(capture.get(PTY_ID)?.retiredPaneKeys).toEqual([])
    expect(capture.get(PTY_ID)?.records).toEqual([
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'claude-session-1' },
        prompt: 'fix the flaky test',
        state: 'done',
        capturedAt: 5000,
        updatedAt: 100,
        origin: 'worktree-sleep',
        restoreOnTabOpenOnly: true,
        connectionId: null
      }
    ])
  })

  it('records nothing from a checkpoint saved for another workspace', async () => {
    const capture = await captureWithoutHookRow(
      savedLiveCheckpoint({ worktreeId: 'repo-1::/work/other' })
    )

    expect(capture.get(PTY_ID)?.records).toEqual([])
  })

  it('records nothing from a checkpoint naming another agent than the pane runs', async () => {
    const capture = await captureWithoutHookRow(savedLiveCheckpoint(), 'codex')

    expect(capture.get(PTY_ID)?.records).toEqual([])
  })

  it('does not re-record a checkpoint the sleep or quit already owns', async () => {
    const capture = await captureWithoutHookRow(savedLiveCheckpoint({ origin: 'quit' }))

    expect(capture.get(PTY_ID)?.records).toEqual([])
  })

  it('retires the pane of an agent the hook store proved exited', async () => {
    const capture = await captureWithoutHookRow(savedLiveCheckpoint(), 'claude', 'exited')

    expect(capture.get(PTY_ID)).toEqual({ retiredPaneKeys: [PANE_KEY], records: [] })
  })

  it('records nothing for a pane with no saved checkpoint', async () => {
    const capture = await captureWithoutHookRow(undefined, 'claude')

    expect(capture.get(PTY_ID)).toEqual({ retiredPaneKeys: [], records: [] })
  })
})
