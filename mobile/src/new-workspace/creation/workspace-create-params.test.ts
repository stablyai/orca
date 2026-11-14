import { describe, expect, it } from 'vitest'
import { buildTaskWorkspaceCreateParams } from './workspace-create-params'

describe('task workspace create params', () => {
  it('omits startup draft and agent when blank terminal is selected', () => {
    const params = buildTaskWorkspaceCreateParams({
      item: {
        provider: 'github',
        source: {
          type: 'issue',
          repoId: 'repo-1',
          number: 88,
          title: 'Investigate login',
          url: 'https://github.com/acme/app/issues/88'
        }
      },
      targetRepoId: 'ignored-for-github',
      setupDecision: 'skip',
      agent: 'blank'
    })

    expect(params).toMatchObject({
      repo: 'id:repo-1',
      name: 'issue-88',
      displayName: 'Investigate login',
      displayNameKind: 'generated',
      setupDecision: 'skip',
      activate: true,
      linkedIssue: 88
    })
    expect(params).not.toHaveProperty('startupDraft')
    expect(params).not.toHaveProperty('createdWithAgent')
  })

  it('keeps the startup draft when no agent was provided so the host can auto-pick', () => {
    const params = buildTaskWorkspaceCreateParams({
      item: {
        provider: 'github',
        source: {
          type: 'issue',
          repoId: 'repo-1',
          number: 89,
          title: 'Auto-pick agent',
          url: 'https://github.com/acme/app/issues/89'
        }
      },
      targetRepoId: 'ignored-for-github',
      setupDecision: 'inherit'
    })

    expect(params).toMatchObject({
      startupDraft: 'https://github.com/acme/app/issues/89',
      linkedIssue: 89
    })
    expect(params).not.toHaveProperty('createdWithAgent')
  })

  it('links GitLab merge requests and carries explicit base branch overrides', () => {
    expect(
      buildTaskWorkspaceCreateParams({
        item: {
          provider: 'gitlab',
          source: {
            type: 'mr',
            repoId: 'repo-2',
            number: 7,
            title: 'Port drawer',
            url: 'https://gitlab.com/acme/app/-/merge_requests/7'
          }
        },
        targetRepoId: 'ignored-for-gitlab',
        setupDecision: 'inherit',
        agent: 'claude',
        baseBranch: 'origin/release',
        hostedStartPoint: { baseBranch: 'origin/main' },
        branchNameOverride: 'port-drawer',
        sparseCheckout: { directories: ['mobile'], presetId: 'preset-1' },
        note: '  keep mobile parity  '
      })
    ).toMatchObject({
      repo: 'id:repo-2',
      name: 'mr-7',
      displayName: 'Port drawer',
      startupDraft: 'https://gitlab.com/acme/app/-/merge_requests/7',
      createdWithAgent: 'claude',
      linkedGitLabMR: 7,
      baseBranch: 'origin/release',
      branchNameOverride: 'port-drawer',
      sparseCheckout: { directories: ['mobile'], presetId: 'preset-1' },
      comment: 'keep mobile parity'
    })
  })

  it('links Jira through linkedWorkItem because worktree.create has no flat Jira field', () => {
    const params = buildTaskWorkspaceCreateParams({
      item: {
        provider: 'jira',
        source: {
          key: 'ORCA-123',
          title: 'Add Jira to mobile',
          url: 'https://acme.atlassian.net/browse/ORCA-123'
        }
      },
      targetRepoId: 'repo-jira',
      setupDecision: 'inherit',
      agent: 'claude',
      note: 'mobile parity'
    })

    expect(params).toMatchObject({
      repo: 'id:repo-jira',
      name: 'orca-123',
      displayName: 'ORCA-123 Add Jira to mobile',
      startupDraft: 'https://acme.atlassian.net/browse/ORCA-123',
      createdWithAgent: 'claude',
      comment: 'mobile parity',
      linkedWorkItem: {
        provider: 'jira',
        type: 'issue',
        number: 0,
        title: 'Add Jira to mobile',
        url: 'https://acme.atlassian.net/browse/ORCA-123',
        jiraIdentifier: 'ORCA-123'
      }
    })
    // A stray linkedLinearIssue would relink the workspace to the wrong provider.
    expect(params).not.toHaveProperty('linkedLinearIssue')
  })
})
