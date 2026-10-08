import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcess } from '../../src/shared/child-process/run-process'

const head = 'abcdef0123'.repeat(4)

async function checkFreshness(freshness, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'hourly-preflight-'))
  const output = join(directory, 'output')
  try {
    const result = await runProcess({
      program: 'bash',
      args: [
        '-c',
        `gh() {
          case "$1 $2" in
            "api "*) printf '%s\\n' "$HEAD_SHA" ;;
            "release list") printf '%s\\n' "$LAST_TAG" ;;
            "release view") printf '%s\\n' "$LAST_SHA" ;;
            *) return 1 ;;
          esac
        }
        ${freshness.run}`
      ],
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: 'stablyai/orca',
        MAIN_REPO_TOKEN: 'main-token',
        HOURLY_REPO: 'stablyai/orca-hourly',
        DAILY_REPO: 'stablyai/orca-daily',
        HEAD_SHA: head,
        LAST_TAG: 'previous-hourly',
        LAST_SHA: head.slice(0, 12),
        FORCED: 'false',
        ...overrides
      }
    })
    return {
      exitCode: result.code,
      stderr: result.stderr,
      stdout: result.stdout,
      output: result.code === 0 ? readFileSync(output, 'utf8') : ''
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe.each(['hourly', 'daily'])('%s build preflight', (channel) => {
  const workflow = parse(
    readFileSync(
      new URL(`../../.github/workflows/${channel}-mac-build.yml`, import.meta.url),
      'utf8'
    )
  )
  const preflight = workflow.jobs.preflight
  const freshness = preflight.steps.find((step) => step.id === 'freshness')
  it('gates Mac allocation and pins the checkout and downstream identity', () => {
    const build = workflow.jobs[`build-${channel}-mac`]
    expect(preflight['runs-on']).toBe('ubuntu-latest')
    expect(preflight.steps.some((step) => step.uses?.startsWith('actions/checkout'))).toBe(false)
    expect(
      preflight.steps.find((step) => step.id === 'app_token').with['permission-contents']
    ).toBe('read')
    const token = preflight.steps.find((step) => step.id === 'app_token')
    expect(token.with['app-id']).toBe('${{ secrets.HOURLY_RELEASE_APP_ID }}')
    expect(token.with['private-key']).toBe('${{ secrets.HOURLY_RELEASE_APP_PRIVATE_KEY }}')
    expect(build.needs).toContain('preflight')
    expect(build.if).toContain("needs.preflight.outputs.should_build == 'true'")
    expect(build.steps.find((step) => step.name === 'Checkout').with.ref).toBe(
      build.outputs.head_sha
    )
    expect(build.outputs.head_sha).toBe('${{ needs.preflight.outputs.head_sha }}')
    expect(build.steps.find((step) => step.id === 'release').env.SHA).toBe(build.outputs.head_sha)
    expect(workflow.concurrency).toEqual({
      group: `${channel}-mac-build`,
      'cancel-in-progress': false
    })
  })

  it.each([
    ['unchanged', {}, false],
    ['changed', { LAST_SHA: '123456789012' }, true],
    ['forced', { FORCED: 'true' }, true],
    ['first build', { LAST_TAG: '' }, true],
    ['missing prior identity', { LAST_SHA: '' }, true]
  ])('%s main selects the expected build decision', async (_name, env, shouldBuild) => {
    const result = await checkFreshness(freshness, env)
    expect(result.exitCode, `${result.stdout} ${result.stderr}`).toBe(0)
    expect(result.output).toBe(`head_sha=${head}\nshould_build=${shouldBuild}\n`)
  })

  it('fails closed when main cannot be resolved, even when forced', async () => {
    const result = await checkFreshness(freshness, { HEAD_SHA: '', FORCED: 'true' })
    expect(result.exitCode).not.toBe(0)
  })
})
