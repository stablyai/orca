import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock } = vi.hoisted(() => ({ ghExecFileAsyncMock: vi.fn() }))

vi.mock('../../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: ghExecFileAsyncMock
}))

vi.mock('../api/rate-limit', () => ({
  repositoryRateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRepositoryRateLimitSpend: vi.fn()
}))

import { listAccessibleProjects } from './project-view-discovery'
import { _resetProjectViewCachesForTests } from './project-view-cache'

// Stands in for gh answering on its own default host when Orca passes no --hostname.
function mockGh(defaultHost: string): void {
  ghExecFileAsyncMock.mockImplementation(async (args: string[], options: { host?: string }) => {
    const host = options.host ?? defaultHost
    const viewer = args.some((arg) => arg.includes('organizations'))
      ? { organizations: { nodes: [] } }
      : {
          login: 'kelora',
          url: `https://${host}/kelora`,
          projectsV2: {
            nodes: [
              {
                id: 'PVT_1',
                number: 1,
                title: 'Roadmap',
                url: `https://${host}/users/kelora/projects/1`,
                owner: { __typename: 'User', login: 'kelora' }
              }
            ]
          }
        }
    return { stdout: JSON.stringify({ data: { viewer } }), stderr: '' }
  })
}

function mockGhScopeFailure(failOrgQuery = false): void {
  const scopeError = Object.assign(new Error('gh failed'), {
    stderr: "GraphQL: Your token has not been granted the required scopes: ['read:project']",
    stdout: ''
  })
  ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    const orgQuery = args.some((arg) => arg.includes('organizations'))
    if (orgQuery !== failOrgQuery) {
      return {
        stdout: JSON.stringify({
          data: { viewer: { login: 'kelora', url: 'https://ghe.example.com/kelora' } }
        }),
        stderr: ''
      }
    }
    throw scopeError
  })
}

const HOSTLESS_SCOPE_MESSAGE =
  'GitHub project access needs additional scopes. Run `gh auth refresh -s project -s read:org -s repo`.'

function ghCalls(): { command: string; host: unknown }[] {
  return ghExecFileAsyncMock.mock.calls.map(([args, options]) => ({
    command: args[0],
    host: options.host
  }))
}

describe('listAccessibleProjects', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    _resetProjectViewCachesForTests()
  })

  it("browses gh's default host when no host is pinned", async () => {
    mockGh('ghe.example.com')

    const result = await listAccessibleProjects({})

    expect(result).toMatchObject({ ok: true, projects: [{ host: 'ghe.example.com' }] })
    // No auth probe and no --hostname: gh resolves GH_HOST or its only login itself.
    expect(ghCalls()).toEqual([
      { command: 'api', host: undefined },
      { command: 'api', host: undefined }
    ])
  })

  it('leaves the host out of unpinned sign-in guidance without probing gh auth', async () => {
    mockGhScopeFailure()

    const result = await listAccessibleProjects({})

    expect(result).toEqual({
      ok: false,
      error: { type: 'scope_missing', message: HOSTLESS_SCOPE_MESSAGE }
    })
    expect(ghCalls()).toEqual([{ command: 'api', host: undefined }])
  })

  it('leaves the host out of an unpinned organization-discovery failure', async () => {
    mockGhScopeFailure(true)

    const result = await listAccessibleProjects({})

    expect(result).toMatchObject({
      ok: true,
      partialFailures: [{ owner: '*', message: HOSTLESS_SCOPE_MESSAGE }]
    })
  })

  it('keeps an explicitly pinned host', async () => {
    mockGh('ghe.example.com')

    const result = await listAccessibleProjects({ host: 'github.com' })

    expect(result).toMatchObject({ ok: true, projects: [{ host: 'github.com' }] })
    expect(ghCalls()).toEqual([
      { command: 'api', host: 'github.com' },
      { command: 'api', host: 'github.com' }
    ])
  })
})
