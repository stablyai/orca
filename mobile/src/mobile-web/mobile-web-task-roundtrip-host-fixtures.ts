import { taskRoundtripProjectHostResponse } from './mobile-web-task-roundtrip-project-fixtures'
import {
  taskRoundtripGitHubItem,
  taskRoundtripGitHubPullRequest,
  taskRoundtripLinearItem
} from './mobile-web-task-roundtrip-item-fixtures'

export const TASK_ROUNDTRIP_HOST_REPO_ID = 'host-repo-private'

export function taskRoundtripHostResponse(method: string): { ok: true; result: unknown } {
  const projectResponse = taskRoundtripProjectHostResponse(method)
  if (projectResponse) {
    return projectResponse
  }
  if (method === 'repo.list') {
    return {
      ok: true,
      result: {
        repos: [
          {
            id: TASK_ROUNDTRIP_HOST_REPO_ID,
            displayName: 'Orca',
            path: '/private/host/orca',
            kind: 'git',
            privateMetadata: 'host-only'
          }
        ]
      }
    }
  }
  if (method === 'status.get') {
    return { ok: true, result: { capabilities: ['mobile.tasks.v1'] } }
  }
  if (method === 'settings.get') {
    return {
      ok: true,
      result: {
        settings: {
          defaultTuiAgent: 'codex',
          disabledTuiAgents: ['claude'],
          defaultRepoSelection: [TASK_ROUNDTRIP_HOST_REPO_ID],
          visibleTaskProviders: ['github', 'linear', 'jira'],
          visibleTaskProvidersDefaultedForJira: true
        }
      }
    }
  }
  if (method === 'ui.get') {
    return {
      ok: true,
      result: {
        ui: {
          taskResumeState: { githubMode: 'items' },
          trustedOrcaHooks: {
            [TASK_ROUNDTRIP_HOST_REPO_ID]: {
              setup: { contentHash: 'f'.repeat(64), approvedAt: 10 }
            }
          }
        }
      }
    }
  }
  if (method === 'preflight.check') {
    return { ok: true, result: { glab: { installed: true } } }
  }
  if (method === 'linear.status') {
    return {
      ok: true,
      result: {
        connected: true,
        workspaces: [{ id: 'linear-workspace', displayName: 'Orca' }],
        selectedWorkspaceId: 'linear-workspace'
      }
    }
  }
  if (method === 'linear.listTeams') {
    return { ok: true, result: [{ id: 'team-1', name: 'Mobile', key: 'MOB' }] }
  }
  if (method === 'github.repoSlug') {
    return { ok: true, result: { owner: 'stablyai', repo: 'orca', host: 'github.com' } }
  }
  if (method === 'github.listWorkItems') {
    return {
      ok: true,
      result: {
        items: [taskRoundtripGitHubItem(), taskRoundtripGitHubPullRequest()],
        sources: {
          issues: null,
          prs: null,
          originCandidate: { owner: 'private', repo: 'origin' },
          upstreamCandidate: null
        },
        errors: {
          issues: { message: 'Issue source unavailable', type: 'forbidden' }
        }
      }
    }
  }
  if (method === 'github.countWorkItems') {
    return { ok: true, result: 2 }
  }
  if (method === 'github.createIssue' || method === 'gitlab.createIssue') {
    return {
      ok: true,
      result: { ok: true, number: 14, url: 'https://github.com/stablyai/orca/issues/14' }
    }
  }
  if (method === 'repo.update') {
    return { ok: true, result: { ok: true } }
  }
  if (method === 'gitlab.listWorkItems') {
    return {
      ok: true,
      result: {
        items: [
          {
            id: 'gitlab-9',
            type: 'issue',
            number: 9,
            title: 'GitLab task',
            state: 'opened',
            url: 'https://gitlab.com/stablyai/orca/-/issues/9',
            labels: [],
            updatedAt: '2026-07-24T00:00:00Z',
            author: 'octo',
            projectRef: { host: 'gitlab.example.com', path: 'private/upstream' }
          },
          {
            id: 'gitlab-10',
            type: 'mr',
            number: 10,
            title: 'GitLab review',
            state: 'opened',
            url: 'https://gitlab.com/stablyai/orca/-/merge_requests/10',
            labels: [],
            updatedAt: '2026-07-24T00:00:00Z',
            author: 'octo',
            projectRef: { host: 'gitlab.example.com', path: 'private/upstream' }
          }
        ]
      }
    }
  }
  if (method === 'gitlab.todos') {
    return {
      ok: true,
      result: [
        {
          id: 11,
          actionName: 'review_requested',
          targetType: 'MergeRequest',
          targetIid: 9,
          targetTitle: 'Review todo',
          targetUrl: 'https://gitlab.com/stablyai/orca/-/merge_requests/9',
          projectPath: 'stablyai/orca',
          authorUsername: 'octo',
          updatedAt: '2026-07-24T00:00:00Z',
          state: 'pending'
        }
      ]
    }
  }
  if (method === 'linear.listIssues') {
    return { ok: true, result: [taskRoundtripLinearItem()] }
  }
  if (method === 'github.listLabels') {
    return { ok: true, result: ['mobile'] }
  }
  if (method === 'github.listAssignableUsers') {
    return { ok: true, result: [{ login: 'octo', name: 'Octo' }] }
  }
  if (method === 'github.workItemDetails') {
    return {
      ok: true,
      result: {
        body: 'GitHub details',
        comments: [
          {
            id: 23,
            body: 'Looks good',
            threadId: 'thread-1',
            path: 'src/file.ts',
            line: 7
          }
        ],
        item: { labels: ['mobile'] },
        assignees: ['octo'],
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        pullRequestId: 'pull-request-node',
        checks: [],
        files: [{ path: 'src/file.ts', status: 'modified', viewerViewedState: 'UNVIEWED' }]
      }
    }
  }
  if (method === 'github.rerunPRChecks') {
    return { ok: true, result: { ok: true } }
  }
  if (method === 'gitlab.workItemDetails') {
    return {
      ok: true,
      result: {
        body: 'GitLab details',
        comments: [],
        item: { labels: ['mobile'] },
        assignees: [],
        pipelineJobs: []
      }
    }
  }
  if (method === 'linear.getIssue') {
    return {
      ok: true,
      result: { ...taskRoundtripLinearItem(), description: 'Linear details' }
    }
  }
  if (method === 'linear.connect' || method === 'linear.selectWorkspace') {
    return { ok: true, result: { ok: true } }
  }
  if (method === 'linear.teamStates') {
    return {
      ok: true,
      result: [{ id: 'state-started', name: 'In Progress', type: 'started', color: '#888888' }]
    }
  }
  if (method === 'linear.updateIssue') {
    return { ok: true, result: { ok: true } }
  }
  if (method === 'linear.addIssueComment') {
    return { ok: true, result: { ok: true, id: 'linear-comment-new' } }
  }
  if (method === 'linear.createIssue') {
    return {
      ok: true,
      result: {
        ok: true,
        id: 'linear-created',
        identifier: 'MOB-13',
        title: 'Created Linear issue',
        url: 'https://linear.app/orca/issue/MOB-13'
      }
    }
  }
  if (method === 'linear.issueComments') {
    return { ok: true, result: [{ id: 'linear-comment', body: 'Linear comment' }] }
  }
  return { ok: true, result: {} }
}
