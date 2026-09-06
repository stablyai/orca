import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_WORKSPACE_SNAPSHOT_MAX_BYTES } from '../../../src/shared/mobile-web/bridge-operation-contract'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { mobileWebWorkspaceSnapshot } from './mobile-web-workspace-snapshot'

describe('mobile web workspace snapshot', () => {
  it('preserves bounded presentation data without host paths, secrets, or pane keys', () => {
    const snapshot = createSnapshot(
      {
        worktrees: [
          {
            worktreeId: 'workspace-parent',
            repoId: 'repo-1',
            worktreeInstanceId: 'instance-parent',
            displayName: 'Parent',
            repo: '/private/repos/orca',
            branch: 'refs/heads/main',
            path: '/private/repos/orca',
            workspaceStatus: 'in-progress',
            sortOrder: 7,
            manualOrder: 3,
            lastActivityAt: 42,
            createdAt: 21,
            isArchived: false,
            isMainWorktree: true,
            hasHostSidebarActivity: true,
            liveTerminalCount: 2,
            hasAttachedPty: true,
            unread: true,
            lastOutputAt: 41,
            isPinned: true,
            isActive: true,
            linkedPR: { number: 17, state: 'OPEN' },
            linkedIssue: 12,
            linkedLinearIssue: 'ORC-7',
            linkedGitLabMR: 8,
            linkedGitLabIssue: 9,
            comment: 'Review this',
            status: 'working',
            pairingCredential: 'credential-must-not-cross',
            terminalHandle: 'terminal-must-not-cross',
            agents: [
              {
                paneKey: 'real-parent-pane',
                parentPaneKey: null,
                state: 'working',
                agentType: 'codex',
                prompt: 'Implement it',
                taskTitle: 'Migration',
                displayName: 'Worker',
                lastAssistantMessage: 'Working',
                toolName: 'shell',
                toolInput: '/private/repos/orca',
                interrupted: false,
                stateStartedAt: 20,
                updatedAt: 40
              },
              {
                paneKey: 'real-child-pane',
                parentPaneKey: 'real-parent-pane',
                state: 'waiting',
                agentType: 'claude',
                prompt: '',
                interrupted: true,
                stateStartedAt: 30,
                updatedAt: 41
              }
            ]
          },
          {
            worktreeId: 'workspace-child',
            repoId: 'repo-1',
            parentWorktreeId: 'workspace-parent',
            parentWorktreeInstanceId: 'instance-parent',
            displayName: 'Child',
            repo: 'orca',
            branch: 'feature/mobile',
            path: 'C:\\private\\repos\\orca-child'
          }
        ]
      },
      10
    )

    expect(snapshot).toMatchObject({
      truncated: false,
      workspaces: [
        {
          id: `workspace_0_${'01'.repeat(16)}`,
          repoId: `repo_1_${'01'.repeat(16)}`,
          name: 'Parent',
          repo: 'orca',
          branch: 'main',
          folderName: 'orca',
          workspaceStatus: 'in-progress',
          sortOrder: 7,
          manualOrder: 3,
          linkedPR: { number: 17, state: 'OPEN' },
          status: 'working',
          agents: [
            { id: 'agent-0', parentId: null, state: 'working' },
            { id: 'agent-1', parentId: 'agent-0', state: 'waiting' }
          ]
        },
        {
          id: `workspace_2_${'01'.repeat(16)}`,
          parentWorkspaceId: `workspace_0_${'01'.repeat(16)}`,
          folderName: 'orca-child'
        }
      ]
    })
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('/private/repos')
    expect(serialized).not.toContain('credential-must-not-cross')
    expect(serialized).not.toContain('terminal-must-not-cross')
    expect(serialized).not.toContain('real-parent-pane')
    expect(serialized).not.toContain('real-child-pane')
  })

  it('defaults malformed fields and rejects invalid or cyclic lineage', () => {
    const snapshot = createSnapshot(
      {
        worktrees: [
          {
            worktreeId: 'one',
            repoId: 7,
            displayName: 9,
            repo: null,
            branch: null,
            parentWorktreeId: 'two',
            liveTerminalCount: -1,
            linkedPR: { number: -1 },
            agents: [{ paneKey: 'pane', state: 'invalid', updatedAt: -1 }]
          },
          { worktreeId: 'two', parentWorktreeId: 'one' },
          { nope: true }
        ]
      },
      10
    )

    expect(snapshot.truncated).toBe(true)
    expect(snapshot.workspaces[0]).toMatchObject({
      repoId: `repo_1_${'01'.repeat(16)}`,
      name: 'Workspace',
      repo: 'Repository',
      branch: 'No branch',
      parentWorkspaceId: null,
      liveTerminalCount: 0,
      linkedPR: null,
      status: 'inactive',
      agents: [{ state: 'done', updatedAt: 0 }]
    })
    expect(snapshot.workspaces[1]?.parentWorkspaceId).toBeNull()
  })

  it('enforces count and aggregate encoded-byte limits', () => {
    const worktrees = Array.from({ length: 240 }, (_, index) => ({
      worktreeId: `workspace-${index}`,
      repoId: `repo-${index}`,
      displayName: `Workspace ${index} ${'x'.repeat(160)}`,
      repo: `Repository ${index} ${'r'.repeat(220)}`,
      branch: `feature/${index}/${'b'.repeat(220)}`,
      path: `/private/${index}/${'f'.repeat(160)}`,
      comment: 'c'.repeat(512),
      agents: Array.from({ length: 16 }, (__, agentIndex) => ({
        paneKey: `pane-${index}-${agentIndex}`,
        state: 'working',
        prompt: 'p'.repeat(512),
        lastAssistantMessage: 'm'.repeat(512),
        stateStartedAt: agentIndex,
        updatedAt: agentIndex
      }))
    }))

    const snapshot = createSnapshot({ worktrees }, 200)

    expect(snapshot.truncated).toBe(true)
    expect(snapshot.workspaces.length).toBeLessThan(200)
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeLessThanOrEqual(
      MOBILE_WEB_WORKSPACE_SNAPSHOT_MAX_BYTES
    )
  })
})

function createSnapshot(result: unknown, limit: number) {
  return mobileWebWorkspaceSnapshot(
    result,
    limit,
    new MobileWebWorkspaceAuthority((length) => new Uint8Array(length).fill(1))
  )
}
