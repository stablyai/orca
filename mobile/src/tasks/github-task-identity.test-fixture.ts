import type { TaskItem } from './mobile-tasks-project-workspace-types'
import type { GitHubProjectRow } from './mobile-tasks-view-state-types'

export function item(owner: string) {
  return {
    key: owner,
    provider: 'github',
    title: owner,
    subtitle: '',
    status: 'Open',
    updatedAt: '',
    source: {
      id: 'pr:93',
      repoId: 'clone',
      repoName: 'clone',
      type: 'pr',
      number: 93,
      title: owner,
      state: 'open',
      labels: [],
      author: null,
      updatedAt: '',
      url: `https://github.corp/${owner}/widgets/pull/93`,
      prRepo: { owner, repo: 'widgets', host: 'github.corp' }
    }
  } satisfies Extract<TaskItem, { provider: 'github' }>
}

export function projectRow(owner: string): GitHubProjectRow {
  return {
    id: owner,
    itemType: 'PULL_REQUEST',
    updatedAt: '',
    content: {
      number: 93,
      title: owner,
      body: '',
      url: `https://github.corp/${owner}/widgets/pull/93`,
      state: 'OPEN',
      isDraft: false,
      repository: `${owner}/widgets`,
      labels: [],
      assignees: []
    }
  }
}
