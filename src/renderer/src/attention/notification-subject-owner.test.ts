import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import { notificationSourceForOwner } from '../../../shared/notifications/notification-source'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { resolveTerminalNotificationOwner } from './notification-subject-owner'

const REMOTE = 'repo1::/tmp/remote'
const CATALOG = {
  runtimeEnvironments: [
    { id: 'env-b', source: 'manual' as const },
    { id: 'env-c', source: 'manual' as const }
  ]
}

const RUNTIME_HOST: Partial<Worktree> = {
  hostId: 'runtime:env-b',
  runtimeOwnerEnvironmentId: 'env-b'
}

function sourceFor(
  ptyId: string | undefined,
  tabIds: string[],
  host = RUNTIME_HOST
): string | undefined {
  const state = {
    worktreesByRepo: {
      repo1: [makeWorktree({ ...host, id: REMOTE, repoId: 'repo1' })]
    },
    tabsByWorktree: {
      [REMOTE]: tabIds.map((id) => makeTab({ id, ptyId, worktreeId: REMOTE }))
    },
    ptyIdsByTabId: Object.fromEntries(tabIds.map((id) => [id, ptyId ? [ptyId] : []])),
    terminalLayoutsByTabId: {}
  }
  const owner = resolveTerminalNotificationOwner(state, REMOTE, { ptyId })
  return notificationSourceForOwner(owner, CATALOG)
}

describe('resolveTerminalNotificationOwner machine mute', () => {
  it('names the workspace machine when a remote PTY id cannot name it', () => {
    expect(sourceFor('remote:lost-host', ['tab-1'])).toBe('runtime:env-b')
  })

  it('never names this computer for a remote PTY id in a local workspace', () => {
    expect(sourceFor('remote:lost-host', ['tab-1'], { hostId: 'local' })).toBeUndefined()
  })

  it('names the machine a remote PTY id carries when its tab binding is ambiguous', () => {
    expect(sourceFor('remote:env-c@@pty-1', ['tab-1', 'tab-2'])).toBe('runtime:env-c')
  })

  it('names the workspace machine for a pane with no PTY and no tab', () => {
    expect(sourceFor(undefined, [])).toBe('runtime:env-b')
  })
})
