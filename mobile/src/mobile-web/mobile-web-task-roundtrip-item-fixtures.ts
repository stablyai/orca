export function taskRoundtripGitHubItem() {
  return {
    id: 'github-7',
    type: 'issue',
    number: 7,
    title: 'Typed tasks',
    state: 'open',
    url: 'https://github.com/stablyai/orca/issues/7',
    labels: [],
    updatedAt: '2026-07-24T00:00:00Z',
    author: 'octo'
  }
}

export function taskRoundtripGitHubPullRequest() {
  return {
    ...taskRoundtripGitHubItem(),
    id: 'github-8',
    type: 'pr',
    number: 8,
    title: 'Review typed tasks',
    url: 'https://github.com/stablyai/orca/pull/8'
  }
}

export function taskRoundtripLinearItem() {
  return {
    id: 'linear-12',
    workspaceId: 'linear-workspace',
    identifier: 'MOB-12',
    title: 'Linear task',
    url: 'https://linear.app/orca/issue/MOB-12',
    state: { name: 'In Progress', type: 'started', color: '#888888' },
    team: { id: 'team-1', name: 'Mobile', key: 'MOB' },
    labels: [],
    priority: 2,
    updatedAt: '2026-07-24T00:00:00Z'
  }
}
