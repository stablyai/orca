import { beforeEach, describe, expect, it } from 'vitest'
import type { DebugSession } from '../../shared/debug-session-types'
import {
  getDebugSession,
  listAllDebugSessions,
  listDebugSessionsForWorktree,
  registerDebugSession,
  unregisterDebugSession,
  updateDebugSessionState,
  type DebugSessionRuntime
} from './debug-session-registry'

function makeSession(id: string, worktreeId: string): DebugSession {
  return {
    id,
    worktreeId,
    hostId: 'local',
    config: { type: 'node', request: 'launch', command: 'node', args: [] },
    state: 'initializing'
  }
}

function makeRuntime(id: string, worktreeId: string): DebugSessionRuntime {
  return {
    session: makeSession(id, worktreeId),
    client: {} as DebugSessionRuntime['client'],
    machine: {} as DebugSessionRuntime['machine']
  }
}

describe('debug-session-registry', () => {
  beforeEach(() => {
    for (const runtime of listAllDebugSessions()) {
      unregisterDebugSession(runtime.session.id)
    }
  })

  it('scopes sessions per worktree independently', () => {
    registerDebugSession(makeRuntime('session-1', 'worktree-a'))
    registerDebugSession(makeRuntime('session-2', 'worktree-b'))
    registerDebugSession(makeRuntime('session-3', 'worktree-a'))

    expect(
      listDebugSessionsForWorktree('worktree-a')
        .map((r) => r.session.id)
        .sort()
    ).toEqual(['session-1', 'session-3'])
    expect(listDebugSessionsForWorktree('worktree-b').map((r) => r.session.id)).toEqual([
      'session-2'
    ])
  })

  it('returns an empty list for a worktree with no sessions', () => {
    expect(listDebugSessionsForWorktree('unknown-worktree')).toEqual([])
  })

  it('unregisters exactly the requested session, leaving the other worktree untouched', () => {
    registerDebugSession(makeRuntime('session-1', 'worktree-a'))
    registerDebugSession(makeRuntime('session-2', 'worktree-b'))

    unregisterDebugSession('session-1')

    expect(getDebugSession('session-1')).toBeUndefined()
    expect(listDebugSessionsForWorktree('worktree-a')).toEqual([])
    expect(listDebugSessionsForWorktree('worktree-b')).toHaveLength(1)
  })

  it('unregistering an unknown session id is a no-op', () => {
    registerDebugSession(makeRuntime('session-1', 'worktree-a'))
    expect(() => unregisterDebugSession('does-not-exist')).not.toThrow()
    expect(listAllDebugSessions()).toHaveLength(1)
  })

  it('updateDebugSessionState mutates only the targeted session snapshot', () => {
    registerDebugSession(makeRuntime('session-1', 'worktree-a'))
    registerDebugSession(makeRuntime('session-2', 'worktree-a'))

    updateDebugSessionState('session-1', 'running')

    expect(getDebugSession('session-1')?.session.state).toBe('running')
    expect(getDebugSession('session-2')?.session.state).toBe('initializing')
  })
})
