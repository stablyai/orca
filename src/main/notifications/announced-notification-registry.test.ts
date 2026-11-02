import { describe, expect, it } from 'vitest'
import type { StructuredAttentionOrigin } from '../../shared/agent-session/agent-session-attention'
import {
  createAnnouncedNotificationRegistry,
  worktreeAnnouncementSubject
} from './announced-notification-registry'

const journalOrigin: StructuredAttentionOrigin = {
  scope: {
    executionHostId: 'runtime:host-1',
    wslDistro: null,
    workspaceId: 'ws-1',
    workspaceKind: 'git-worktree'
  },
  sessionId: 'session-1',
  cause: { kind: 'completion', requestId: 'req-1' },
  journalCursor: { epoch: 'epoch-1', sequence: 4 }
}

describe('createAnnouncedNotificationRegistry', () => {
  it('hands back each subject once, newest last, without duplicates', () => {
    const registry = createAnnouncedNotificationRegistry()
    registry.record('pane-a', 'id-1')
    registry.record('pane-a', 'id-2')
    registry.record('pane-a', 'id-1')
    registry.record('pane-b', 'id-3')
    expect(registry.take('pane-a').map((entry) => entry.id)).toEqual(['id-2', 'id-1'])
    expect(registry.take('pane-a').map((entry) => entry.id)).toEqual([])
    expect(registry.take('pane-b').map((entry) => entry.id)).toEqual(['id-3'])
  })

  it('evicts the least recently announced subject and caps ids per subject', () => {
    const registry = createAnnouncedNotificationRegistry({ maxSubjects: 2, maxIdsPerSubject: 2 })
    registry.record('old', 'id-old')
    registry.record('busy', 'id-1')
    registry.record('old', 'id-old-2')
    registry.record('busy', 'id-2')
    registry.record('busy', 'id-3')
    registry.record('new', 'id-new')
    expect(registry.take('old').map((entry) => entry.id)).toEqual([])
    expect(registry.take('busy').map((entry) => entry.id)).toEqual(['id-2', 'id-3'])
    expect(registry.take('new').map((entry) => entry.id)).toEqual(['id-new'])
  })

  it('takes every announcement of a worktree across panes, positioned ones included', () => {
    const registry = createAnnouncedNotificationRegistry()
    registry.record('pane-a', 'id-1', undefined, 'repo::/w')
    registry.record('pane-a', 'id-2', journalOrigin, 'repo::/w')
    registry.record('pane-b', 'id-3', undefined, 'repo::/other')
    registry.record('pane-c', 'id-4', undefined, 'repo::/w')
    const taken = registry.takeByWorktree('repo::/w')
    expect(taken.map((group) => [group.paneKey, group.entries.map((entry) => entry.id)]))
      .toEqual([
        ['pane-a', ['id-1', 'id-2']],
        ['pane-c', ['id-4']]
      ])
    // An exclusive pane reports no other-worktree entries; the mixed one does.
    expect(taken.map((group) => [group.paneKey, group.hasOtherWorktreeEntries])).toEqual([
      ['pane-a', false],
      ['pane-c', false]
    ])
    // Taken once: a second acknowledgement finds nothing, and other worktrees keep theirs.
    expect(registry.takeByWorktree('repo::/w')).toEqual([])
    expect(registry.take('pane-b').map((entry) => entry.id)).toEqual(['id-3'])
  })

  it('keeps a subject alive for its other worktrees when one worktree is taken', () => {
    const registry = createAnnouncedNotificationRegistry()
    registry.record('pane-a', 'id-1', undefined, 'repo::/w1')
    registry.record('pane-a', 'id-2', undefined, 'repo::/w2')
    const [taken] = registry.takeByWorktree('repo::/w1')
    expect(taken.hasOtherWorktreeEntries).toBe(true)
    expect(registry.take('pane-a').map((entry) => entry.id)).toEqual(['id-2'])
  })

  it('takes pane-less worktree announcements filed under the synthetic subject', () => {
    const registry = createAnnouncedNotificationRegistry()
    registry.record(worktreeAnnouncementSubject('repo::/w'), 'id-paneless', undefined, 'repo::/w')
    const taken = registry.takeByWorktree('repo::/w')
    expect(taken.map((group) => [group.paneKey, group.entries.map((entry) => entry.id)]))
      .toEqual([[worktreeAnnouncementSubject('repo::/w'), ['id-paneless']]])
    expect(registry.takeByWorktree('repo::/w')).toEqual([])
  })
})
