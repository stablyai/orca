import { describe, expect, it } from 'vitest'
import type { MobileWebWorkspaceSummary } from '../../../src/shared/mobile-web/bridge-operation-contract'
import { mobileWebWorkspacePresentation } from './mobile-web-workspace-presentation'

describe('mobile web workspace presentation', () => {
  it('adapts the safe bridge shape to the existing mobile Worktree contract', () => {
    const workspace: MobileWebWorkspaceSummary = {
      id: 'opaque-workspace',
      repoId: 'opaque-repo',
      workspaceKind: 'folder-workspace',
      name: 'Docs',
      repo: 'Orca',
      branch: 'folder',
      folderName: 'docs',
      workspaceStatus: 'in-progress',
      sortOrder: 8,
      manualOrder: 4,
      lastActivityAt: 30,
      createdAt: 10,
      isArchived: false,
      isMainWorktree: false,
      hasHostSidebarActivity: true,
      parentWorkspaceId: 'opaque-parent',
      liveTerminalCount: 2,
      hasAttachedPty: true,
      unread: true,
      lastOutputAt: 29,
      isPinned: true,
      isActive: true,
      linkedPR: { number: 5, state: 'OPEN' },
      linkedIssue: 6,
      linkedLinearIssue: 'ORC-7',
      linkedGitLabMR: 8,
      linkedGitLabIssue: 9,
      comment: 'Folder metadata',
      status: 'working',
      agents: [
        {
          id: 'agent-0',
          parentId: null,
          state: 'working',
          agentType: 'codex',
          prompt: 'Implement',
          taskTitle: 'Migration',
          displayName: 'Worker',
          lastAssistantMessage: 'In progress',
          interrupted: false,
          stateStartedAt: 20,
          updatedAt: 29
        }
      ]
    }

    expect(mobileWebWorkspacePresentation(workspace)).toEqual({
      workspaceKind: 'folder-workspace',
      worktreeId: 'opaque-workspace',
      repoId: 'opaque-repo',
      repo: 'Orca',
      branch: 'folder',
      displayName: 'Docs',
      workspaceStatus: 'in-progress',
      sortOrder: 8,
      manualOrder: 4,
      lastActivityAt: 30,
      createdAt: 10,
      path: 'docs',
      isArchived: false,
      isMainWorktree: false,
      hasHostSidebarActivity: true,
      parentWorktreeId: 'opaque-parent',
      liveTerminalCount: 2,
      hasAttachedPty: true,
      preview: '',
      unread: true,
      lastOutputAt: 29,
      isPinned: true,
      isActive: true,
      linkedPR: { number: 5, state: 'OPEN' },
      linkedIssue: 6,
      linkedLinearIssue: 'ORC-7',
      linkedGitLabMR: 8,
      linkedGitLabIssue: 9,
      comment: 'Folder metadata',
      status: 'working',
      agents: [
        {
          paneKey: 'agent-0',
          parentPaneKey: null,
          state: 'working',
          agentType: 'codex',
          prompt: 'Implement',
          taskTitle: 'Migration',
          displayName: 'Worker',
          lastAssistantMessage: 'In progress',
          toolName: null,
          toolInput: null,
          interrupted: false,
          stateStartedAt: 20,
          updatedAt: 29
        }
      ]
    })
  })

  it('never synthesizes an absolute path for git workspaces', () => {
    const workspace = {
      id: 'opaque-workspace',
      repoId: 'opaque-repo',
      workspaceKind: 'git',
      name: 'Feature',
      repo: 'Orca',
      branch: 'feature',
      folderName: 'secret-host-folder',
      workspaceStatus: '',
      sortOrder: 0,
      manualOrder: null,
      lastActivityAt: null,
      createdAt: null,
      isArchived: false,
      isMainWorktree: false,
      hasHostSidebarActivity: false,
      parentWorkspaceId: null,
      liveTerminalCount: 0,
      hasAttachedPty: false,
      unread: false,
      lastOutputAt: null,
      isPinned: false,
      isActive: false,
      linkedPR: null,
      linkedIssue: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      comment: '',
      status: 'inactive',
      agents: []
    } satisfies MobileWebWorkspaceSummary

    expect(mobileWebWorkspacePresentation(workspace).path).toBe('')
  })
})
