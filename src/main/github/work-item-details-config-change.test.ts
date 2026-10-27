import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import type * as GitExecError from '../git/exec-error'
import type * as WorkItemLookup from './client/fetch/get-work-item'
import { runProcess } from '@orca/process-host'

const { ghMock, fixture } = vi.hoisted(() => {
  const fixture: {
    path: string
    initialHost: string
    replacementUrl: string
    requests: { args: string[]; host?: string }[]
  } = { path: '', initialHost: '', replacementUrl: '', requests: [] }
  return { ghMock: vi.fn(), fixture }
})

vi.mock('node:os', async (original) => ({
  ...(await original<typeof NodeOs>()),
  homedir: () => join(fixture.path, 'isolated-home')
}))

vi.mock('../git/runner', async () => {
  const errors = await vi.importActual<typeof GitExecError>('../git/exec-error')
  return {
    ...errors,
    ghExecFileAsync: ghMock,
    gitExecFileAsync: async (args: string[], options: { cwd?: string }) => {
      const result = await runProcess({
        program: 'git',
        args,
        cwd: options.cwd,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: join(fixture.path, 'isolated-home', '.gitconfig')
        }
      })
      if (result.code !== 0) {
        throw new Error(result.stderr)
      }
      return { stdout: result.stdout, stderr: result.stderr }
    }
  }
})

vi.mock('./client', async () => ({
  ...(await vi.importActual<typeof WorkItemLookup>('./client/fetch/get-work-item')),
  getPRChecks: vi.fn(),
  getPRComments: vi.fn()
}))

vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: () => ({ blocked: false }),
  noteRepositoryRateLimitSpend: vi.fn()
}))

import { getWorkItemDetails } from './work-item-details'
import { _resetOwnerRepoCache } from './github-repository-identity'
import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'
import { _resetGitHubHostAuthCache } from './github-enterprise-repository'

async function fixtureGit(args: string[]): Promise<void> {
  const result = await runProcess({
    program: 'git',
    args,
    cwd: fixture.path,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(fixture.path, 'isolated-home', '.gitconfig')
    }
  })
  expect(result.code, result.stderr).toBe(0)
}

beforeEach(async () => {
  fixture.path = await mkdtemp(join(tmpdir(), 'orca-issue-config-change-'))
  await mkdir(join(fixture.path, 'isolated-home'))
  await fixtureGit(['init', '--quiet'])
  await fixtureGit(['remote', 'add', 'origin', 'https://github.com/fork-owner/widgets.git'])
  _resetOwnerRepoCache()
  _resetOriginGitHubApiRepositoryCache()
  _resetGitHubHostAuthCache()
  fixture.initialHost = 'github.com'
  fixture.replacementUrl = 'https://github.com/replacement-owner/widgets.git'
  fixture.requests = []
  ghMock.mockReset()
  ghMock.mockImplementation(async (args: string[], options: { host?: string }) => {
    fixture.requests.push({ args, host: options.host })
    if (args[0] === 'auth' && args[1] === 'status') {
      return {
        stdout: ['github.com', 'github.enterprise.test']
          .map((host) => `${host}\n  Logged in to ${host} account fixture (keyring)`)
          .join('\n'),
        stderr: ''
      }
    }
    if (args.includes('repos/fork-owner/widgets/issues/5')) {
      await fixtureGit(['remote', 'set-url', 'origin', fixture.replacementUrl])
      return {
        stdout: JSON.stringify({
          number: 5,
          title: 'ORIGIN title',
          state: 'open',
          html_url: `https://${fixture.initialHost}/fork-owner/widgets/issues/5`,
          labels: [],
          updated_at: '2026-10-02T00:00:00Z',
          user: { login: 'fork-author' }
        }),
        stderr: ''
      }
    }
    if (args.includes('graphql')) {
      const original = args.includes('owner=fork-owner') && options.host === fixture.initialHost
      const marker = original ? 'ORIGIN' : 'REPLACEMENT'
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              issue: {
                body: `${marker} body`,
                assignees: { nodes: [{ login: `${marker}-assignee` }] },
                participants: { nodes: [] },
                comments: {
                  nodes: [
                    {
                      databaseId: 1,
                      body: `${marker} comment`,
                      createdAt: '2026-10-02T00:00:00Z',
                      url: `https://${options.host}/fork-owner/widgets/issues/5#issuecomment-1`,
                      author: { login: `${marker}-author`, avatarUrl: '' }
                    }
                  ]
                }
              }
            }
          }
        }),
        stderr: ''
      }
    }
    if (args.some((arg) => arg.includes('/timeline?'))) {
      return { stdout: '[]', stderr: '' }
    }
    throw new Error(`Unexpected fixture gh request: ${args.join(' ')}`)
  })
})

afterEach(async () => {
  await rm(fixture.path, { recursive: true, force: true })
})

it.each(['issue', undefined] as const)(
  'keeps implicit %s conversation on the repository used for the item fetch',
  async (type) => {
    const details = await getWorkItemDetails(fixture.path, 5, type, null, {}, 'origin')
    expect(details?.item.title).toBe('ORIGIN title')
    expect(details?.body).toBe('ORIGIN body')
    expect(details?.assignees).toEqual(['ORIGIN-assignee'])
    expect(details?.comments.map((comment) => comment.body)).toEqual(['ORIGIN comment'])
    expect(fixture.requests[1].args).toContain('owner=fork-owner')
  }
)

it('keeps an explicit local Tasks identity through the same real config change', async () => {
  const details = await getWorkItemDetails(fixture.path, 5, 'issue', null, {}, 'origin', {
    owner: 'fork-owner',
    repo: 'widgets',
    host: 'github.com'
  })
  expect(details?.item.title).toBe('ORIGIN title')
  expect(details?.body).toBe('ORIGIN body')
})

it.each([
  { from: 'github.com', to: 'github.enterprise.test', qualified: false },
  { from: 'github.enterprise.test', to: 'github.com', qualified: false },
  { from: 'github.com', to: 'github.enterprise.test', qualified: true },
  { from: 'github.enterprise.test', to: 'github.com', qualified: true }
])(
  'keeps explicit host from $from to $to (qualified=$qualified)',
  async ({ from, to, qualified }) => {
    fixture.initialHost = from
    fixture.replacementUrl = `https://${to}/fork-owner/widgets.git`
    await fixtureGit(['remote', 'set-url', 'origin', `https://${from}/fork-owner/widgets.git`])
    const details = await getWorkItemDetails(fixture.path, 5, 'issue', null, {}, 'origin', {
      owner: 'fork-owner',
      repo: 'widgets',
      ...(qualified ? { host: from } : {})
    })
    expect(details?.item.url).toBe(`https://${from}/fork-owner/widgets/issues/5`)
    expect(details?.body).toBe('ORIGIN body')
    expect(details?.assignees).toEqual(['ORIGIN-assignee'])
    expect(details?.comments.map((comment) => comment.body)).toEqual(['ORIGIN comment'])
    const conversationRequests = fixture.requests.filter(
      ({ args }) => args.includes('graphql') || args.some((arg) => arg.includes('/timeline?'))
    )
    expect(conversationRequests.some(({ args }) => args.includes('graphql'))).toBe(true)
    expect(
      conversationRequests.some(({ args }) => args.some((arg) => arg.includes('/timeline?')))
    ).toBe(true)
    expect(conversationRequests.map(({ host }) => host)).toEqual([from, from])
  }
)
