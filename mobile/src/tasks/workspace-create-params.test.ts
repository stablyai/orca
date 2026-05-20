import { describe, expect, it } from 'vitest'
import { buildTaskWorkspaceCreateParams } from './workspace-create-params'

describe('task workspace create params', () => {
  it('passes a GitHub PR URL as an agent draft and links the PR', () => {
    expect(
      buildTaskWorkspaceCreateParams({
        item: {
          provider: 'github',
          source: {
            type: 'pr',
            repoId: 'repo-1',
            number: 123,
            title: 'Fix mobile tasks',
            url: 'https://github.com/acme/app/pull/123'
          }
        },
        targetRepoId: 'ignored-for-github',
        setupDecision: 'run',
        agent: 'codex',
        workspaceName: '  mobile-tasks  ',
        hostedStartPoint: {
          baseBranch: 'origin/main',
          pushTarget: { remoteName: 'origin', branchName: 'feature/mobile-tasks' }
        }
      })
    ).toMatchObject({
      repo: 'id:repo-1',
      name: 'mobile-tasks',
      displayName: 'Fix mobile tasks',
      setupDecision: 'run',
      activate: true,
      startupDraft: 'https://github.com/acme/app/pull/123',
      createdWithAgent: 'codex',
      linkedPR: 123,
      baseBranch: 'origin/main',
      pushTarget: { remoteName: 'origin', branchName: 'feature/mobile-tasks' }
    })
  })

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

  it('creates Linear workspaces in the selected repo and links the identifier', () => {
    expect(
      buildTaskWorkspaceCreateParams({
        item: {
          provider: 'linear',
          source: {
            identifier: 'ENG-42',
            title: 'Ship Linear parity',
            url: 'https://linear.app/acme/issue/ENG-42/ship-linear-parity'
          }
        },
        targetRepoId: 'repo-linear',
        setupDecision: 'inherit',
        agent: 'grok'
      })
    ).toMatchObject({
      repo: 'id:repo-linear',
      name: 'eng-42',
      displayName: 'Ship Linear parity',
      linkedLinearIssue: 'ENG-42',
      startupDraft: 'https://linear.app/acme/issue/ENG-42/ship-linear-parity',
      createdWithAgent: 'grok'
    })
  })
})
