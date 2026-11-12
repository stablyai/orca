import type * as GithubRepositoryIdentityModule from '../../repositories/github-repository-identity'
import type * as GhExecFileModule from '../../../git/command-runner/hosted-cli/gh-exec-file'
import type * as GithubApiRepositoryModule from '../../repositories/github-api-repository'
import type * as GithubApiRepositoryRemoteProbeModule from '../../repositories/github-api-repository-remote-probe'
import type * as GitExecFileModule from '../../../git/command-runner/git-exec-file'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as GitHubEnterpriseRepositoryModule from '../../repositories/github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('../client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('../../execution/github-legacy-command', () =>
  moduleMocks.githubLegacyCommandModuleMock(clientMocks)
)

vi.mock('../../repositories/github-owner-repo-selection', () =>
  moduleMocks.githubOwnerSelectionModuleMock(clientMocks)
)

vi.mock('../../repositories/github-repository-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubRepositoryIdentityModule>()),
  ...moduleMocks.githubRepositoryIdentityModuleMock(clientMocks)
}))

vi.mock('../../api/gh-error-classification', () =>
  moduleMocks.githubErrorClassificationModuleMock()
)

vi.mock('../../execution/github-operation-slots', () =>
  moduleMocks.githubOperationSlotsModuleMock(clientMocks)
)

vi.mock('../../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecFileModule>()),
  gitExecFileAsync: clientMocks.gitExecFileAsyncMock
}))

vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GhExecFileModule>()),
  ...moduleMocks.githubHostedCliModuleMock(clientMocks)
}))
vi.mock('../../repositories/local-git-config-signature', () =>
  moduleMocks.localGitConfigSignatureModuleMock(clientMocks)
)
vi.mock('../../repositories/github-enterprise-repository', async (importOriginal) =>
  moduleMocks.githubEnterpriseRepositoryModuleMock(
    await importOriginal<typeof GitHubEnterpriseRepositoryModule>()
  )
)
vi.mock('../../api/rate-limit', () => moduleMocks.rateLimitModuleMock(clientMocks))
vi.mock('../../repositories/github-api-repository', async (importOriginal) =>
  moduleMocks.githubApiRepositoryModuleMock(
    clientMocks,
    await importOriginal<typeof GithubApiRepositoryModule>()
  )
)

vi.mock('../../repositories/github-api-repository-remote-probe', async (importOriginal) =>
  moduleMocks.githubApiRepositoryRemoteProbeModuleMock(
    clientMocks,
    await importOriginal<typeof GithubApiRepositoryRemoteProbeModule>()
  )
)

import { getPRForBranch } from './get-pr-for-branch'
import { resetPRForBranchMocks } from '../client-test-harness'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  gitExecFileAsyncMock,
  resolvePRRepositoryCandidatesMock
} = clientMocks

const BRANCH = 'feature'

function scriptGit(config: Record<string, string>, remotes: string[]): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'for-each-ref') {
      return { stdout: `refs/heads/${BRANCH}\0\n`, stderr: '' }
    }
    if (args[0] === 'config' && args[1] === '--list') {
      const records = Object.entries(config).map(([key, value]) => `${key}\n${value}\0`)
      return { stdout: records.join(''), stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === '-v') {
      return { stdout: `${remotes.join('\n')}\n`, stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

/** Serves one open PR whose head is `headOwner:headBranch` in `webHost`/stablyai/orca. */
function scriptGitHub(headOwner: string, headBranch: string, webHost = 'github.com'): void {
  const head = encodeURIComponent(`${headOwner}:${headBranch}`)
  const url = `https://${webHost}/stablyai/orca/pull/91`
  ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    const path = args[1] ?? ''
    if (args[0] === 'auth') {
      return {
        stdout: `${webHost}\n  ✓ Logged in to ${webHost} account me (keyring)\n`,
        stderr: ''
      }
    }
    if (path.includes('/pulls?head=')) {
      const rows = path.includes(`head=${head}&`)
        ? [
            {
              number: 91,
              title: 'Published from a fork',
              state: 'open',
              html_url: url,
              updated_at: '2026-11-01T00:00:00Z',
              draft: false,
              mergeable: true,
              base: { ref: 'main', sha: 'base-oid' },
              head: {
                ref: headBranch,
                sha: 'head-oid',
                repo: { name: 'orca', owner: { login: headOwner } }
              }
            }
          ]
        : []
      return { stdout: JSON.stringify(rows) }
    }
    return {
      stdout: JSON.stringify({
        number: 91,
        title: 'Published from a fork',
        state: 'OPEN',
        url,
        statusCheckRollup: [],
        updatedAt: '2026-11-01T00:00:00Z',
        isDraft: false,
        mergeable: 'MERGEABLE',
        baseRefName: 'main',
        headRefName: headBranch,
        baseRefOid: 'base-oid',
        headRefOid: 'head-oid',
        isCrossRepository: headOwner !== 'stablyai',
        headRepositoryOwner: { login: headOwner },
        headRepository: { name: 'orca' }
      })
    }
  })
}

describe('getPRForBranch configured push head', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
    getOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
  })

  it('finds a fork PR through a remote that fetches upstream and pushes to the fork', async () => {
    scriptGit({ 'remote.origin.url': 'git@github.com:stablyai/orca.git' }, [
      'origin\tgit@github.com:stablyai/orca.git (fetch)',
      'origin\tgit@github.com:contributor/orca.git (push)'
    ])
    scriptGitHub('contributor', BRANCH)

    const pr = await getPRForBranch('/repo-root', BRANCH)

    expect(pr).toMatchObject({
      number: 91,
      prRepo: { owner: 'stablyai', repo: 'orca' },
      headRepo: { owner: 'contributor', repo: 'orca' }
    })
  })

  it('finds a fork PR through branch.<name>.pushRemote', async () => {
    scriptGit(
      {
        'remote.origin.url': 'git@github.com:stablyai/orca.git',
        'remote.fork.url': 'git@github.com:contributor/orca.git',
        [`branch.${BRANCH}.pushremote`]: 'fork'
      },
      [
        'origin\tgit@github.com:stablyai/orca.git (fetch)',
        'origin\tgit@github.com:stablyai/orca.git (push)',
        'fork\tgit@github.com:contributor/orca.git (fetch)',
        'fork\tgit@github.com:contributor/orca.git (push)'
      ]
    )
    scriptGitHub('contributor', BRANCH)

    const pr = await getPRForBranch('/repo-root', BRANCH)

    expect(pr).toMatchObject({ number: 91, headRepo: { owner: 'contributor', repo: 'orca' } })
  })

  it('finds a PR whose head is the remote branch a push refspec publishes to', async () => {
    scriptGit(
      {
        'remote.origin.url': 'git@github.com:stablyai/orca.git',
        'remote.origin.push': `refs/heads/${BRANCH}:refs/heads/published-name`
      },
      [
        'origin\tgit@github.com:stablyai/orca.git (fetch)',
        'origin\tgit@github.com:stablyai/orca.git (push)'
      ]
    )
    scriptGitHub('stablyai', 'published-name')

    const pr = await getPRForBranch('/repo-root', BRANCH)

    expect(pr).toMatchObject({ number: 91, headRefName: 'published-name' })
  })

  it('finds a fork PR through a separate pushurl on a GitHub Enterprise host', async () => {
    const enterprise = { owner: 'stablyai', repo: 'orca', host: 'ghe.example' }
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [enterprise],
      headRepo: enterprise
    })
    scriptGit({ 'remote.origin.url': 'https://ghe.example/stablyai/orca.git' }, [
      'origin\thttps://ghe.example/stablyai/orca.git (fetch)',
      'origin\thttps://ghe.example/contributor/orca.git (push)'
    ])
    scriptGitHub('contributor', BRANCH, 'ghe.example')

    const pr = await getPRForBranch('/repo-root', BRANCH)

    expect(pr).toMatchObject({
      number: 91,
      headRepo: { owner: 'contributor', repo: 'orca', host: 'ghe.example' }
    })
  })
})
