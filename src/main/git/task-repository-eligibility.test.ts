import { beforeEach, expect, it, vi } from 'vitest'

const { git, glab } = vi.hoisted(() => ({ git: vi.fn(), glab: vi.fn() }))

vi.mock('./command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: git
}))

vi.mock('./command-runner/glab-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  glabExecFileAsync: glab
}))

import { isTaskRepositoryIneligible } from './task-repository-eligibility'
import { _resetKnownHostsCache } from '../gitlab/gitlab-known-host-probe'

// Real glab 1.128 output: exit 1 because gitlab.com has no token.
const tokenlessGitLabComFailure = Object.assign(new Error('Command failed: glab auth status'), {
  code: 1,
  killed: false,
  signal: null,
  outputTruncated: false,
  stdout: '',
  stderr: [
    'gitlab.com',
    '  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401 {message: 401 Unauthorized}',
    '  ! No token found (checked config file, keyring, and environment variables).',
    'gitlab.example.com',
    '  ✓ Logged in to gitlab.example.com as yasu (/Users/yasu/.config/glab-cli/config.yml)',
    '  x could not authenticate to one or more of the configured GitLab instances.'
  ].join('\n')
})

beforeEach(() => {
  vi.resetAllMocks()
  _resetKnownHostsCache()
  glab.mockRejectedValue(tokenlessGitLabComFailure)
})

it.each([
  ['git@gitlab.example.com:team/project.git', true],
  ['git@git.unknown.example:team/project.git', false]
])('treats %s as proven GitLab for GitHub tasks: %s', async (url, ineligible) => {
  git.mockResolvedValue({ stdout: `origin\t${url} (fetch)\norigin\t${url} (push)\n` })

  await expect(isTaskRepositoryIneligible('/repo', 'github')).resolves.toBe(ineligible)
})
