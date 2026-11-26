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
  state.gitlabHosts = ['gitlab.com', 'gitlab.example.com', 'gitlab.example.com:8080']
  state.authenticatedHosts = []
})

function remotes(...urls: string[]): void {
  state.remoteLines = urls.map((url, index) => `remote${index}\t${url} (fetch)`).join('\n')
}

it('hides a project whose remotes are all GitLab', async () => {
  remotes('http://gitlab.example.com:8080/acme/widgets.git', 'git@gitlab.com:acme/widgets.git')

  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(true)
})

it('keeps a GitLab project with an unknown mirror remote', async () => {
  remotes(
    'http://gitlab.example.com:8080/acme/widgets.git',
    'http://mirror.example.org:3000/acme/widgets.git'
  )

  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(false)
})

it('keeps a project with GitHub over HTTPS or SSH', async () => {
  remotes('http://gitlab.example.com:8080/acme/widgets.git', 'git@github.com:acme/widgets.git')
  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(false)

  remotes('http://gitlab.example.com:8080/acme/widgets.git', 'https://github.com/acme/widgets.git')
  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(false)
})

it('keeps an unknown SSH alias', async () => {
  remotes('http://gitlab.example.com:8080/acme/widgets.git', 'ssh://unknown-alias/acme/widgets.git')

  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(false)
})

it('keeps a GitHub Enterprise host whether or not it is authenticated', async () => {
  remotes(
    'http://gitlab.example.com:8080/acme/widgets.git',
    'https://ghe.example.com/acme/widgets.git'
  )
  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(false)

  state.authenticatedHosts = ['ghe.example.com']
  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(false)
})

it('keeps an unauthenticated *.ghe.com remote unknown', async () => {
  remotes(
    'http://gitlab.example.com:8080/acme/widgets.git',
    'https://acme.ghe.com/team/widgets.git'
  )

  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(false)
})

it('treats known public non-GitHub forges as exclusion evidence', async () => {
  remotes(
    'http://gitlab.example.com:8080/acme/widgets.git',
    'https://bitbucket.org/acme/widgets.git'
  )
  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(true)

  remotes(
    'http://gitlab.example.com:8080/acme/widgets.git',
    'https://dev.azure.com/acme/widgets.git'
  )
  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(true)
})

it('keeps a project with no remotes or an explicit connection', async () => {
  remotes()

  expect(await isTaskRepositoryIneligible('/repo', 'github')).toBe(false)
  remotes('https://github.com/acme/widgets.git')
  expect(await isTaskRepositoryIneligible('/repo', 'github', 'connection-1')).toBe(false)
})

it('mirrors the rule for the GitLab provider', async () => {
  remotes('git@github.com:acme/widgets.git', 'https://github.com/acme/tools.git')
  expect(await isTaskRepositoryIneligible('/repo', 'gitlab')).toBe(true)

  remotes('git@github.com:acme/widgets.git', 'http://gitlab.example.com:8080/acme/widgets.git')
  expect(await isTaskRepositoryIneligible('/repo', 'gitlab')).toBe(false)
})
