import { beforeEach, expect, it, vi } from 'vitest'

type MockState = {
  remoteLines: string
  gitlabHosts: string[]
  authenticatedHosts: string[]
}

const state: MockState = vi.hoisted(() => ({
  remoteLines: '',
  gitlabHosts: [],
  authenticatedHosts: []
}))

vi.mock('../command-runner/git-exec-file', () => ({
  gitExecFileAsync: async () => ({ stdout: state.remoteLines })
}))

vi.mock('../../gitlab/projects/gitlab-known-host-probe', () => ({
  getGlabKnownHosts: async () => state.gitlabHosts,
  getGlabPartialHosts: () => []
}))

vi.mock('../../github/repositories/github-enterprise-repository', () => ({
  isGitHubHostAuthenticated: async (host: string) => state.authenticatedHosts.includes(host)
}))

import { isTaskRepositoryIneligible } from './task-repository-eligibility'

beforeEach(() => {
  state.remoteLines = ''
  state.gitlabHosts = ['gitlab.example.com', 'gitlab.example.com:8080']
  state.authenticatedHosts = []
})

function remotes(...urls: string[]): void {
  state.remoteLines = urls.map((url, index) => `remote${index}\t${url} (fetch)`).join('\n')
}

it('hides a project whose remotes are all GitLab', async () => {
  remotes(
    'http://gitlab.example.com:8080/acme/widgets.git',
    'https://gitlab.example.com/acme/widgets.git'
  )

  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(true)
})

it('hides a GitLab project with an extra non-GitHub mirror (#49583)', async () => {
  remotes(
    'http://gitlab.example.com:8080/acme/widgets.git',
    'http://mirror.example.org:3000/acme/widgets.git'
  )

  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(true)
})

it('keeps a project that also has a GitHub remote', async () => {
  remotes('http://gitlab.example.com:8080/acme/widgets.git', 'git@github.com:acme/widgets.git')

  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(false)
})

it('keeps a project with an SSH alias, which cannot rule out GitHub', async () => {
  remotes(
    'http://gitlab.example.com:8080/acme/widgets.git',
    'ssh://gitlab-internal/acme/widgets.git'
  )

  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(false)

  remotes('http://gitlab.example.com:8080/acme/widgets.git', 'ssh://unknown-alias/acme/widgets.git')
  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(false)
})

it('keeps a project with no remotes or an explicit connection', async () => {
  remotes()

  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(false)
  remotes('git@github.com:acme/widgets.git')
  expect(await isTaskRepositoryIneligible('/repo', 'github', 'connection-1')).toBe(false)
})

it('mirrors the rule for the GitLab provider', async () => {
  remotes('https://github.com/acme/widgets.git', 'https://github.com/acme/tools.git')

  expect(await isTaskRepositoryIneligible('/repo', 'gitlab')).toBe(true)

  remotes('https://github.com/acme/widgets.git', 'http://gitlab.example.com:8080/acme/widgets.git')
  expect(await isTaskRepositoryIneligible('/repo', 'gitlab')).toBe(false)
})
