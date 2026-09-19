import { describe, expect, it } from 'vitest'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { lookupOpenCodeSessionPane } from '../../shared/agent-hook-listener/opencode-session-registry'
import { makePaneKey } from '../../shared/stable-pane-id'
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
  return { pid, ppid, startedAtMs, argv }
}

function pane(paneKey: string, shellPid: number | null): BinderPaneSnapshot {
  return { paneKey, directory: DIR, worktreeId: 'repo::/Users/jin/work/mocitec', shellPid }
}

describe('runOpenCodeBinderRound', () => {
  it('attributes a client to its pane subtree and binds the session', () => {
    const { ownerships } = runOpenCodeBinderRound({
      nowMs: NOW,
      dbPath: '/tmp/opencode.db',
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

  it('ignores clients outside every pane subtree', () => {
    const { ownerships } = runOpenCodeBinderRound({
      nowMs: NOW,
      dbPath: '/tmp/opencode.db',
      sessions: [{ id: 'ses_1', directory: DIR, createdAtMs: NOW - 60_000, parentId: null }],
      panes: [pane(PANE_A, 100)],
      processes: [proc(100, 1, ['zsh']), proc(999, 1, ['opencode'], NOW - 90_000)],
      knownOwners: new Map(),
      parentBySessionId: new Map()
    })
    expect(ownerships).toEqual([])
  })

  it('inherits a root owner across the watermark via the parent map', () => {
    const { ownerships } = runOpenCodeBinderRound({
      nowMs: NOW,
      dbPath: '/tmp/opencode.db',
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

  it('advances the watermark past seen sessions', () => {
    const { watermarkMs } = runOpenCodeBinderRound({
      nowMs: NOW,
      dbPath: '/tmp/opencode.db',
      sessions: [
        { id: 'ses_1', directory: DIR, createdAtMs: NOW - 60_000, parentId: null },
        { id: 'ses_2', directory: DIR, createdAtMs: NOW - 10_000, parentId: null }
      ],
      panes: [],
      processes: [],
      knownOwners: new Map(),
      parentBySessionId: new Map()
    })
    expect(watermarkMs).toBe(NOW - 10_000)
  })
})

describe('applyBinderOwnerships', () => {
  it('writes bindings with the pane worktree into the registry', () => {
    const state = createHookListenerState()
    const applied = applyBinderOwnerships(
      state,
      [pane(PANE_A, 100)],
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
