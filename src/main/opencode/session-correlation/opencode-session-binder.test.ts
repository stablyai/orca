import { describe, expect, it } from 'vitest'
import { createHookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import { lookupOpenCodeSessionPane } from '../../../shared/agent-hook-listener/opencode-session-registry'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import type { ProcessIdentityRow } from './opencode-client-sweep'
import {
  applyBinderOwnerships,
  runOpenCodeBinderRound,
  type BinderPaneSnapshot
} from './opencode-session-binder'

const NOW = 1_700_000_100_000
const DIR = '/Users/jin/work/mocitec'
const PANE_A = makePaneKey('tab-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const PANE_B = makePaneKey('tab-b', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')

function proc(
  pid: number,
  ppid: number,
  argv: string[],
  startedAtMs = NOW - 120_000
): ProcessIdentityRow {
  return { pid, ppid, startedAtMs, executable: argv[0] ?? '', argv }
}

function pane(paneKey: string, shellPid: number | null): BinderPaneSnapshot {
  return { paneKey, directory: DIR, worktreeId: 'repo::/Users/jin/work/mocitec', shellPid }
}

describe('runOpenCodeBinderRound', () => {
  it('attributes a client to its pane subtree and binds the session', () => {
    const { ownerships } = runOpenCodeBinderRound({
      nowMs: NOW,
      sessions: [{ id: 'ses_1', directory: DIR, createdAtMs: NOW - 60_000, parentId: null }],
      panes: [pane(PANE_A, 100), pane(PANE_B, 200)],
      processes: [
        proc(100, 1, ['zsh']),
        proc(200, 1, ['zsh']),
        proc(210, 200, ['opencode'], NOW - 90_000)
      ],
      knownOwners: new Map(),
      parentBySessionId: new Map()
    })
    expect(ownerships).toEqual([
      { sessionId: 'ses_1', paneKey: PANE_B, basis: 'creation-correlation' }
    ])
  })

  it('inherits a root owner across the watermark via the parent map', () => {
    const { ownerships } = runOpenCodeBinderRound({
      nowMs: NOW,
      sessions: [
        { id: 'ses_child', directory: DIR, createdAtMs: NOW - 30_000, parentId: 'ses_root' }
      ],
      panes: [pane(PANE_A, 100)],
      processes: [proc(100, 1, ['zsh']), proc(101, 100, ['opencode'], NOW - 3_600_000)],
      knownOwners: new Map([['ses_root', PANE_A]]),
      parentBySessionId: new Map([['ses_child', 'ses_root']])
    })
    expect(ownerships).toEqual([
      { sessionId: 'ses_child', paneKey: PANE_A, basis: 'creation-correlation' }
    ])
  })
})

describe('applyBinderOwnerships', () => {
  it('takes the newest row worktree when a pane remints', () => {
    const state = createHookListenerState()
    // Insert stale first so a reminted pane’s newer worktree must win.
    const applied = applyBinderOwnerships(
      state,
      [
        { paneKey: PANE_A, directory: '/elsewhere', worktreeId: 'repo::/elsewhere', shellPid: 100 },
        { ...pane(PANE_A, 101) }
      ],
      [{ sessionId: 'ses_1', paneKey: PANE_A, basis: 'argv' }],
      NOW
    )
    expect(applied).toBe(1)
    expect(lookupOpenCodeSessionPane(state, 'ses_1')).toMatchObject({
      paneKey: PANE_A,
      worktreeId: 'repo::/Users/jin/work/mocitec'
    })
  })
})
