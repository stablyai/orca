import { describe, expect, it } from 'vitest'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { lookupOpenCodeSessionPane } from '../../shared/agent-hook-listener/opencode-session-registry'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { ProcessIdentityRow } from './opencode-client-sweep'
import {
  advanceBinderCursor,
  applyBinderOwnerships,
  OPENCODE_SESSION_CURSOR_START,
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

function pane(
  paneKey: string,
  shellPid: number | null,
  lastInputAtMs: number | null = null
): BinderPaneSnapshot {
  return {
    paneKey,
    directory: DIR,
    worktreeId: 'repo::/Users/jin/work/mocitec',
    shellPid,
    lastInputAtMs
  }
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

  it('ignores clients outside every pane subtree', () => {
    const { ownerships } = runOpenCodeBinderRound({
      nowMs: NOW,
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

  it('dedupes same-key snapshots newest-wins', () => {
    const { ownerships } = runOpenCodeBinderRound({
      nowMs: NOW,
      sessions: [{ id: 'ses_1', directory: DIR, createdAtMs: NOW - 60_000, parentId: null }],
      panes: [
        { ...pane(PANE_A, 100), directory: '/elsewhere' },
        { ...pane(PANE_A, 101), directory: DIR }
      ],
      processes: [
        proc(100, 1, ['zsh']),
        proc(101, 1, ['zsh']),
        proc(102, 101, ['opencode'], NOW - 90_000)
      ],
      knownOwners: new Map(),
      parentBySessionId: new Map()
    })
    expect(ownerships).toEqual([
      { sessionId: 'ses_1', paneKey: PANE_A, basis: 'single-pane-directory' }
    ])
  })

  it('breaks a same-directory tie from the pane snapshots input', () => {
    const { ownerships } = runOpenCodeBinderRound({
      nowMs: NOW,
      sessions: [{ id: 'ses_1', directory: DIR, createdAtMs: NOW - 60_000, parentId: null }],
      panes: [pane(PANE_A, 100, NOW - 3_600_000), pane(PANE_B, 200, NOW - 65_000)],
      processes: [
        proc(100, 1, ['zsh']),
        proc(200, 1, ['zsh']),
        proc(101, 100, ['opencode'], NOW - 86_400_000),
        proc(201, 200, ['opencode'], NOW - 86_400_000)
      ],
      knownOwners: new Map(),
      parentBySessionId: new Map()
    })
    expect(ownerships).toEqual([
      { sessionId: 'ses_1', paneKey: PANE_B, basis: 'creation-correlation' }
    ])
  })

  it('keeps a reminted pane input history when its live row has none', () => {
    const { ownerships } = runOpenCodeBinderRound({
      nowMs: NOW,
      sessions: [{ id: 'ses_1', directory: DIR, createdAtMs: NOW - 60_000, parentId: null }],
      panes: [
        pane(PANE_A, 100, NOW - 65_000),
        pane(PANE_A, 101, null),
        pane(PANE_B, 200, NOW - 3_600_000)
      ],
      processes: [
        proc(100, 1, ['zsh']),
        proc(101, 1, ['zsh']),
        proc(200, 1, ['zsh']),
        proc(102, 100, ['opencode'], NOW - 86_400_000),
        proc(201, 200, ['opencode'], NOW - 86_400_000)
      ],
      knownOwners: new Map(),
      parentBySessionId: new Map()
    })
    expect(ownerships).toEqual([
      { sessionId: 'ses_1', paneKey: PANE_A, basis: 'creation-correlation' }
    ])
  })

  it('does not carry input across a directory change', () => {
    // The remint row now points at DIR, but the input recorded under it
    // happened while the pane sat in /elsewhere. Carrying it forward would let
    // a session in DIR win a tie on keystrokes that never happened there.
    const { ownerships } = runOpenCodeBinderRound({
      nowMs: NOW,
      sessions: [{ id: 'ses_1', directory: DIR, createdAtMs: NOW - 60_000, parentId: null }],
      panes: [
        { ...pane(PANE_A, 100, NOW - 65_000), directory: '/elsewhere' },
        { ...pane(PANE_A, 101, null), directory: DIR },
        pane(PANE_B, 200, NOW - 3_600_000)
      ],
      processes: [
        proc(100, 1, ['zsh']),
        proc(101, 1, ['zsh']),
        proc(200, 1, ['zsh']),
        proc(102, 101, ['opencode'], NOW - 86_400_000),
        proc(201, 200, ['opencode'], NOW - 86_400_000)
      ],
      knownOwners: new Map(),
      parentBySessionId: new Map()
    })
    expect(ownerships).toEqual([])
  })

  it('advances the cursor past handled rows only', () => {
    const fresh = [
      { id: 'ses_1', directory: DIR, createdAtMs: NOW - 60_000, parentId: null },
      { id: 'ses_2', directory: DIR, createdAtMs: NOW - 10_000, parentId: null }
    ]
    expect(
      advanceBinderCursor({
        fresh,
        isHandled: () => true,
        current: OPENCODE_SESSION_CURSOR_START
      })
    ).toEqual({ ms: NOW - 10_000, id: 'ses_2' })
  })

  it('freezes the cursor before the first unhandled row so it is re-listed', () => {
    const fresh = [
      { id: 'ses_1', directory: DIR, createdAtMs: NOW - 60_000, parentId: null },
      { id: 'ses_2', directory: DIR, createdAtMs: NOW - 10_000, parentId: null }
    ]
    expect(
      advanceBinderCursor({
        fresh,
        isHandled: (id) => id === 'ses_1',
        current: OPENCODE_SESSION_CURSOR_START
      })
    ).toEqual({ ms: NOW - 60_000, id: 'ses_1' })
  })

  it('keeps the cursor when nothing was handled', () => {
    const current = { ms: NOW - 120_000, id: 'ses_0' }
    expect(
      advanceBinderCursor({
        fresh: [{ id: 'ses_1', directory: DIR, createdAtMs: NOW - 60_000, parentId: null }],
        isHandled: () => false,
        current
      })
    ).toBe(current)
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

  it('takes the newest row worktree when a pane remints', () => {
    const state = createHookListenerState()
    // Registry insertion order puts the stale row first; the live remint row
    // carries a different worktree and must win, matching the round's
    // newest-wins pane dedupe.
    const applied = applyBinderOwnerships(
      state,
      [
        {
          paneKey: PANE_A,
          directory: '/elsewhere',
          worktreeId: 'repo::/elsewhere',
          shellPid: 100,
          lastInputAtMs: null
        },
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
