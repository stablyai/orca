import { describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { removeWorktreeMetaRow } from '../persistence/host-qualified-worktree-meta'
import { pluginEventWorkspaceListId } from './plugin-event-workspace-id'
import { projectPluginAgentStatusChangedPayload } from './plugin-agent-status-event'

function metaStore(rows: Record<string, WorktreeMeta>) {
  return {
    getWorktreeMeta: (worktreeId: string) => rows[worktreeId],
    removeWorktreeMeta: ({ id }: { id: string }) => {
      delete rows[id]
    }
  }
}

const LOCAL: ExecutionHostId = 'local'
const BASE_META: WorktreeMeta = {
  displayName: '',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}
const meta = (instanceId: string, hostId: ExecutionHostId = LOCAL): WorktreeMeta => ({
  ...BASE_META,
  instanceId,
  hostId
})

describe('workspaceListId on workspace and agent events', () => {
  it('is the identity form for a live worktree, and the raw id without an identity', () => {
    const store = metaStore({ 'r::/a': meta('i1'), 'r::/b': BASE_META })
    expect(pluginEventWorkspaceListId(store, 'r::/a')).toBe('identity:wt2:local:i1')
    expect(pluginEventWorkspaceListId(store, 'r::/b')).toBe('r::/b')
  })

  it('keeps a removed worktree identity after its row is purged', () => {
    const store = metaStore({ 'r::/gone': meta('i2') })
    removeWorktreeMetaRow(store, 'r::/gone', undefined)
    expect(store.getWorktreeMeta('r::/gone')).toBeUndefined()
    expect(pluginEventWorkspaceListId(store, 'r::/gone', { removed: true })).toBe(
      'identity:wt2:local:i2'
    )
  })

  it("never borrows a same-id row's identity from another host", () => {
    const store = metaStore({ 'r::/twin': meta('i3', 'ssh:box') })
    removeWorktreeMetaRow(store, 'r::/twin', LOCAL)
    expect(pluginEventWorkspaceListId(store, 'r::/twin', { removed: true })).toBe('r::/twin')
  })

  it('rides on agent.status.changed only when the pane has a workspace', () => {
    const enriched = {
      paneKey: 'tab:leaf',
      receivedAt: 1,
      payload: { state: 'working' as const, prompt: '', agentType: 'claude' as const }
    }
    const store = metaStore({ 'r::/a': meta('i4') })
    expect(
      projectPluginAgentStatusChangedPayload({ ...enriched, worktreeId: 'r::/a' }, store)
    ).toMatchObject({ workspaceId: 'r::/a', workspaceListId: 'identity:wt2:local:i4' })
    expect(
      projectPluginAgentStatusChangedPayload({ ...enriched, worktreeId: undefined }, store)
    ).not.toHaveProperty('workspaceListId')
  })
})
