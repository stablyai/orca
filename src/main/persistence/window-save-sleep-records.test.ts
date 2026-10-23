import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { windowSaveKeepingMainSleepRecords } from './window-save-sleep-records'

function record(
  paneKey: string,
  overrides: Partial<SleepingAgentSessionRecord>
): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: `session-${paneKey}` },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

const mainClaimed = record('tab-a:leaf', {
  origin: 'worktree-sleep',
  restoreOnTabOpenOnly: true
})
const staleWindowCopy = record('tab-a:leaf', { origin: 'worktree-sleep', state: 'working' })
const hibernation = record('tab-b:leaf', { origin: 'worktree-sleep' })
const quit = record('tab-c:leaf', { origin: 'quit' })

describe('windowSaveKeepingMainSleepRecords', () => {
  it("keeps main's workspace-sleep records over the window's copy and passes the rest", () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the merge reads only the records field.
    const stored = {
      sleepingAgentSessionsByPaneKey: { [mainClaimed.paneKey]: mainClaimed }
    } as WorkspaceSessionState
    const saved = windowSaveKeepingMainSleepRecords(
      stored,
      {
        sleepingAgentSessionsByPaneKey: {
          [staleWindowCopy.paneKey]: staleWindowCopy,
          [hibernation.paneKey]: hibernation,
          [quit.paneKey]: quit
        }
      },
      'patch'
    )
    expect(saved.sleepingAgentSessionsByPaneKey).toEqual({
      [mainClaimed.paneKey]: mainClaimed,
      [hibernation.paneKey]: hibernation,
      [quit.paneKey]: quit
    })
  })

  it('leaves a patch that does not name the field untouched', () => {
    const patch = { activeRepoId: 'repo' }
    expect(windowSaveKeepingMainSleepRecords(stored(), patch, 'patch')).toBe(patch)
  })

  // The window drops its mirror of a record once main resumed the pane; its next save carries no
  // records at all, or names the field as undefined. Neither may erase main's.
  it("keeps main's records through a full save without the field, after the window's resume", () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the merge reads only the records field.
    const save = { activeRepoId: 'repo' } as WorkspaceSessionState
    expect(
      windowSaveKeepingMainSleepRecords(stored(), save, 'set').sleepingAgentSessionsByPaneKey
    ).toEqual({ [mainClaimed.paneKey]: mainClaimed })
  })

  it("keeps main's records through a patch that clears the field", () => {
    const patch = { sleepingAgentSessionsByPaneKey: undefined }
    expect(
      windowSaveKeepingMainSleepRecords(stored(), patch, 'patch').sleepingAgentSessionsByPaneKey
    ).toEqual({ [mainClaimed.paneKey]: mainClaimed })
  })

  it('never writes a workspace-sleep record the window sends for a pane main holds none for', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the merge reads only the records field.
    const empty = {} as WorkspaceSessionState
    const saved = windowSaveKeepingMainSleepRecords(
      empty,
      { sleepingAgentSessionsByPaneKey: { [staleWindowCopy.paneKey]: staleWindowCopy } },
      'patch'
    )
    expect(saved.sleepingAgentSessionsByPaneKey).toBeUndefined()
  })
})

function stored(): WorkspaceSessionState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the merge reads only the records field.
  return {
    sleepingAgentSessionsByPaneKey: { [mainClaimed.paneKey]: mainClaimed }
  } as WorkspaceSessionState
}
