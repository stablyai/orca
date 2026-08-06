import { describe, expect, it } from 'vitest'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../shared/execution-host'
import { mobileTerminalMaterializationKey } from './mobile-terminal-materialization-key'

const BASE_IDENTITY = {
  executionHostId: toSshExecutionHostId('host-a'),
  connectionId: 'host-a',
  worktreeId: 'repo::/worktree',
  parentTabId: 'tab-a',
  leafId: 'leaf-a',
  sessionId: 'ssh:host-a@@session-a',
  workspaceFreshness: 'folder-route-a',
  reconnectGeneration: 1
}

describe('mobile terminal materialization key', () => {
  it.each([
    ['execution host', { executionHostId: toRuntimeExecutionHostId('host-b') }],
    ['connection', { connectionId: 'host-b' }],
    ['worktree', { worktreeId: 'repo::/other-worktree' }],
    ['parent tab', { parentTabId: 'tab-b' }],
    ['leaf', { leafId: 'leaf-b' }],
    ['persisted session', { sessionId: 'ssh:host-a@@session-b' }],
    ['folder routing freshness', { workspaceFreshness: 'folder-route-b' }],
    ['reconnect generation', { reconnectGeneration: 2 }]
  ])('does not coalesce a different %s', (_label, difference) => {
    expect(mobileTerminalMaterializationKey({ ...BASE_IDENTITY, ...difference })).not.toBe(
      mobileTerminalMaterializationKey(BASE_IDENTITY)
    )
  })
})
