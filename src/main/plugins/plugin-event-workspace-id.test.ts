import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import { worktreeHostIdentity } from '../persistence/worktree-meta-host-identity'
import { projectPluginAgentStatusChangedPayload } from './plugin-agent-status-event'

type Row = { instanceId?: string; hostId?: ExecutionHostId }

/** Rows by host, as the Store partitions same-id worktrees; `legacy` is the unqualified row. */
function metaStore(byHost: Record<string, Record<string, Row>>, legacy: Record<string, Row> = {}) {
  return {
    getWorktreeMeta: (worktreeId: string) => legacy[worktreeId],
    getWorktreeMetaForHost: (worktreeId: string, hostId: ExecutionHostId) =>
      byHost[hostId]?.[worktreeId]
  }
}

describe('worktreeHostIdentity', () => {
  it("reads the named host's row only, never a same-id row of another host", () => {
    const store = metaStore(
      { 'ssh:box': { 'r::/w': { instanceId: 'i2', hostId: 'ssh:box' } } },
      { 'r::/w': { instanceId: 'i1', hostId: 'local' } }
    )
    expect(worktreeHostIdentity(store, 'r::/w', 'ssh:box')).toEqual({
      identityKey: 'wt2:ssh%3Abox:i2',
      hostId: 'ssh:box'
    })
    expect(worktreeHostIdentity(store, 'r::/w', 'local')).toEqual({ hostId: 'local' })
  })

  it("follows the row's own host when the caller names none, as removal does", () => {
    const row: Row = { instanceId: 'i3', hostId: 'local' }
    const store = metaStore({ local: { 'r::/gone': row } }, { 'r::/gone': row })
    expect(worktreeHostIdentity(store, 'r::/gone')).toEqual({
      identityKey: 'wt2:local:i3',
      hostId: 'local'
    })
  })
})

describe('workspaceListId on agent.status.changed', () => {
  const enriched = {
    paneKey: 'tab:leaf',
    receivedAt: 1,
    payload: { state: 'working' as const, prompt: '', agentType: 'claude' as const }
  }
  const store = metaStore({ local: { 'r::/a': { instanceId: 'i4', hostId: 'local' } } })

  it("names the workspace by the reporting host's identity, else by its raw id", () => {
    expect(
      projectPluginAgentStatusChangedPayload(
        { ...enriched, worktreeId: 'r::/a', connectionId: null },
        store
      )
    ).toMatchObject({ workspaceId: 'r::/a', workspaceListId: 'identity:wt2:local:i4' })
    // An SSH agent with a same-id local twin does not borrow the local identity.
    expect(
      projectPluginAgentStatusChangedPayload(
        { ...enriched, worktreeId: 'r::/a', connectionId: 'box' },
        store
      )
    ).toMatchObject({ workspaceId: 'r::/a', workspaceListId: 'r::/a' })
    expect(
      projectPluginAgentStatusChangedPayload(
        { ...enriched, worktreeId: undefined, connectionId: null },
        store
      )
    ).not.toHaveProperty('workspaceListId')
  })
})
