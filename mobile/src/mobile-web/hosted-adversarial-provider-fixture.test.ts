import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hostedAdversarialGitHubResponse } from '../../scripts/hosted-adversarial-github-cli.mjs'
import {
  createHostedAdversarialProviderFixture,
  HOSTED_ADVERSARIAL_MERMAID_MARKER,
  HOSTED_ADVERSARIAL_PROVIDER_ERROR_MARKER,
  HOSTED_ADVERSARIAL_PROVIDER_MARKER,
  HOSTED_ADVERSARIAL_PROVIDER_TITLE_MARKER,
  removeHostedAdversarialProviderFixture
} from '../../scripts/hosted-adversarial-provider-fixture.mjs'
import {
  createHostedAdversarialRepositoryFixture,
  removeHostedAdversarialRepositoryFixture
} from '../../scripts/hosted-adversarial-repository-fixture.mjs'

const config = {
  baseOid: 'a'.repeat(40),
  branch: 'orca-adversarial-row',
  body: 'provider body',
  comment: `${HOSTED_ADVERSARIAL_MERMAID_MARKER}\n\n\`\`\`mermaid\ngraph TD\nStart --> Done\n\`\`\``,
  error: `${HOSTED_ADVERSARIAL_PROVIDER_ERROR_MARKER}: hostile`,
  headOid: 'b'.repeat(40),
  title: `${HOSTED_ADVERSARIAL_PROVIDER_TITLE_MARKER}: hostile`,
  updatedAt: '2026-07-29T00:00:00Z'
}
const androidHarnessSource = readFileSync(
  new URL('../../scripts/run-hosted-android-source-control-review-e2e.mjs', import.meta.url),
  'utf8'
)

describe('hosted adversarial provider fixture', () => {
  it('returns one hostile task while another repository error stays bounded', async () => {
    const tasks = await hostedAdversarialGitHubResponse(
      ['api', 'search/issues?q=repo%3Aorca-e2e%2Fadversarial'],
      config
    )
    const issues = await hostedAdversarialGitHubResponse(
      ['api', 'search/issues?q=repo%3Astablyai%2Forca'],
      config
    )

    expect(tasks.code).toBe(0)
    expect(JSON.parse(tasks.stdout)).toMatchObject([
      {
        number: 17,
        title: expect.stringContaining(HOSTED_ADVERSARIAL_PROVIDER_TITLE_MARKER)
      }
    ])
    expect(issues).toMatchObject({
      code: 1,
      stderr: expect.stringContaining(HOSTED_ADVERSARIAL_PROVIDER_ERROR_MARKER)
    })
    expect(issues.stderr.length).toBeLessThanOrEqual(1_000)
  })

  it('registers success and error repositories in the Android runtime', () => {
    expect(androidHarnessSource).toContain("stage('provider error workspace registration'")
    expect(androidHarnessSource).toContain('registerWorktreeForPairingRuntime(runtime, worktree, {')
    expect(androidHarnessSource).toContain(
      'registerWorktreeForPairingRuntime(runtime, testWorkspace, {'
    )
  })

  it('returns a provider comment with the Mermaid corpus', async () => {
    const response = await hostedAdversarialGitHubResponse(
      [
        'api',
        'graphql',
        '-f',
        'query=query { repository { pullRequest { reviewThreads(first: 100) { nodes { id } } } } }'
      ],
      config
    )
    const parsed = JSON.parse(response.stdout)

    expect(parsed.data.repository.pullRequest.comments.nodes[0].body).toContain(
      HOSTED_ADVERSARIAL_MERMAID_MARKER
    )
    expect(parsed.data.repository.pullRequest.comments.nodes[0].body).toContain('```mermaid')
  })

  it('installs an isolated cross-platform gh shim and repository remote', async () => {
    const repository = await createHostedAdversarialRepositoryFixture()
    let fixture
    try {
      fixture = await createHostedAdversarialProviderFixture({
        probePort: 43210,
        repositoryRoot: repository.root
      })
      const fixtureConfig = JSON.parse(await readFile(fixture.configPath, 'utf8'))

      expect(fixture.environment.PATH.split(path.delimiter)[0]).toContain(fixture.root)
      expect(fixtureConfig.body).toContain(`\`${HOSTED_ADVERSARIAL_PROVIDER_MARKER}\``)
      expect(fixtureConfig.comment).toContain(`\`${HOSTED_ADVERSARIAL_MERMAID_MARKER}\``)
      expect(fixtureConfig.comment).toContain('http://127.0.0.1:43210/')
      expect(fixtureConfig.comment).toContain(
        'Start --> Parse --> Sanitize --> Render --> Verify --> Done'
      )
      expect(await readFile(path.join(fixture.root, 'bin', 'gh.cmd'), 'utf8')).toContain(
        'hosted-adversarial-github-cli.mjs'
      )
    } finally {
      if (fixture) {
        await removeHostedAdversarialProviderFixture(fixture, repository.root)
      }
      await removeHostedAdversarialRepositoryFixture(repository)
    }
  })
})
