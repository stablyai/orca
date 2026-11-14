import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/docs.yml', 'utf8'))
const gate = workflow.jobs.release_gate.steps.find((step) => step.id === 'validate').run
const sha = '1234567890123456789012345678901234567890'

function runGate(
  event,
  {
    login = 'release-owner',
    id = 12345,
    configured = '12345',
    draft = false,
    prerelease = false,
    tag = 'v1.4.258',
    ref = 'refs/heads/main'
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'orca-docs-release-'))
  try {
    const release = { tag_name: tag, draft, prerelease, author: { login, id } }
    const output = join(root, 'output')
    const stub = join(root, 'gh')
    writeFileSync(output, '')
    writeFileSync(
      stub,
      `#!/usr/bin/env node
const path = process.argv[3]
if (path.includes('/releases/tags/')) console.log(process.env.FIXTURE_RELEASE)
else if (path.includes('/git/ref/')) console.log(JSON.stringify({object:{type:'commit',sha:'${sha}'}}))
else if (path.includes('/contents/docs/site/package.json')) console.log('{}')
else process.exit(1)
`
    )
    chmodSync(stub, 0o755)
    const result = spawnSync('bash', ['-c', gate], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: 'stablyai/orca',
        EVENT_NAME: event,
        INPUT_TAG: tag,
        RELEASE_TAG: tag,
        RELEASE_AUTHOR: login,
        RELEASE_AUTHOR_ID: String(id),
        RELEASE_PUSH_ACTOR_ID: configured,
        RELEASE_DRAFT: String(draft),
        RELEASE_PRERELEASE: String(prerelease),
        DEFAULT_BRANCH: 'main',
        WORKFLOW_REF: ref,
        FIXTURE_RELEASE: JSON.stringify(release)
      }
    })
    expect(result.status, result.stderr).toBe(0)
    return readFileSync(output, 'utf8')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('docs release creator authorization', () => {
  it.each(['release', 'workflow_dispatch'])(
    'deploys the configured creator or existing bot through %s',
    (event) => {
      expect(runGate(event)).toBe(`commit_sha=${sha}\ndeploy=true\n`)
      expect(runGate(event, { login: 'github-actions[bot]', configured: '' })).toBe(
        `commit_sha=${sha}\ndeploy=true\n`
      )
    }
  )

  it.each(['release', 'workflow_dispatch'])(
    'keeps unauthorized or incomplete releases out through %s',
    (event) => {
      for (const options of [
        { id: 67890 },
        { configured: '' },
        { configured: '12345oops' },
        { draft: true },
        { prerelease: true }
      ]) {
        expect(runGate(event, options)).toBe(`commit_sha=${sha}\ndeploy=false\n`)
      }
      expect(runGate(event, { tag: 'v1.4.258-rc.1' })).toBe('deploy=false\n')
    }
  )

  it('cannot dispatch a configured release from a non-default branch', () => {
    expect(runGate('workflow_dispatch', { ref: 'refs/heads/another-branch' })).toBe(
      `commit_sha=${sha}\ndeploy=false\n`
    )
  })
})
