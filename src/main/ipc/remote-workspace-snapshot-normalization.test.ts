import { describe, expect, it } from 'vitest'

import {
  normalizeSnapshot,
  remoteWorkspaceSessionMatchesSnapshot
} from './remote-workspace-snapshot-normalization'
import type {
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'

function session(overrides: Partial<RemoteWorkspaceSession> = {}): RemoteWorkspaceSession {
  return {
    activeWorktreePath: null,
    activeTabId: null,
    tabsByWorktreePath: {},
    terminalLayoutsByTabId: {},
    ...overrides
  }
}

function snapshotOf(session: RemoteWorkspaceSession): RemoteWorkspaceSnapshot {
  return { namespace: 'ns', revision: 3, updatedAt: 1, schemaVersion: 1, session }
}

/**
 * Every declared field, each holding a value the normalizer must neither drop nor flatten.
 *
 * `Required` is the ratchet: normalizeRemoteSession rebuilds the session as an object literal, so a
 * field added to the wire type and forgotten there is invisible — it round-trips through the
 * projection, reaches the relay, and is stripped on the way back. Declaring the fixture Required
 * makes the next such field a compile error here before it can become a silent data loss.
 */
const everyDeclaredField: Required<RemoteWorkspaceSession> = {
  activeWorktreePath: '/repo',
  activeTabId: 'tab-1',
  tabsByWorktreePath: { '/repo': [{ id: 'tab-1', type: 'terminal', title: 'Shell' } as never] },
  terminalLayoutsByTabId: { 'tab-1': { kind: 'leaf', ptyId: 'pty-1' } as never },
  activeWorktreePathsOnShutdown: ['/repo'],
  activeTabIdByWorktreePath: { '/repo': 'tab-1' },
  remoteSessionIdsByTabId: { 'tab-1': 'session-1' },
  lastVisitedAtByWorktreePath: { '/repo': 42 },
  defaultTerminalTabsAppliedByWorktreePath: { '/repo': true }
}

describe('normalizeSnapshot: field coverage', () => {
  it('copies every declared field of the wire session', () => {
    const normalized = normalizeSnapshot(snapshotOf(everyDeclaredField), 'ns').session

    expect(Object.keys(normalized).sort()).toEqual(Object.keys(everyDeclaredField).sort())
    expect(normalized).toEqual(everyDeclaredField)
  })
})

describe('normalizeSnapshot: defaultTerminalTabsAppliedByWorktreePath', () => {
  it('carries the marker through instead of dropping it', () => {
    // The renderer exports this field and its importer reads it, but the normalizer every read
    // passes through never copied it — so the flag reached the relay and could never come back.
    const raw = snapshotOf(session({ defaultTerminalTabsAppliedByWorktreePath: { '/repo': true } }))

    expect(normalizeSnapshot(raw, 'ns').session.defaultTerminalTabsAppliedByWorktreePath).toEqual({
      '/repo': true
    })
  })

  it('treats an empty marker record as absent, like every other optional record', () => {
    // The export always emits an object, so {} and absent both mean "no worktree has applied
    // them". Collapsing them keeps a no-op export from looking like a change to the patch guard.
    const raw = snapshotOf(session({ defaultTerminalTabsAppliedByWorktreePath: {} }))

    expect(
      normalizeSnapshot(raw, 'ns').session.defaultTerminalTabsAppliedByWorktreePath
    ).toBeUndefined()
  })
})

describe('remoteWorkspaceSessionMatchesSnapshot', () => {
  it('sees a change that only sets the default-terminal-tabs marker', () => {
    // patchRemoteWorkspaceSession short-circuits on this comparison, so a field it cannot see is a
    // field that can never be written at all.
    expect(
      remoteWorkspaceSessionMatchesSnapshot(
        snapshotOf(session()),
        session({ defaultTerminalTabsAppliedByWorktreePath: { '/repo': true } })
      )
    ).toBe(false)
  })
})
