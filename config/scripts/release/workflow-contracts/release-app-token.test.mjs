// Release writes use the release GitHub App; builds use the commit cut verified, never the tag name.
import { readFileSync } from 'node:fs'
import { runProcessSync } from '@orca/process-host'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { dispatchReleaseMacBuildWorkflow } from '../operations/run-release-mac-build-workflow.mjs'

const releaseCut = parse(readFileSync('.github/workflows/release-cut.yml', 'utf8'))
const macBuild = parse(readFileSync('.github/workflows/release-mac-build.yml', 'utf8'))
const PINNED_ACTION = 'actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510'
const TOKEN_USERS = {
  cut: ['publish_drafts', 'Push tag'],
  'create-release': ['draft'],
  'publish-release': ['Publish release']
}

describe('release App token wiring', () => {
  it('mints a scoped token in the release environment right before each release write', () => {
    for (const [name, job] of Object.entries(releaseCut.jobs)) {
      const mints =
        job.steps?.filter((step) => step.uses?.startsWith('actions/create-github-app-token')) ?? []
      if (!TOKEN_USERS[name]) {
        expect(mints, name).toEqual([])
        continue
      }
      expect(job.environment, name).toBe('release')
      expect(
        job.steps.find((step) => step.name === 'Require release App credentials'),
        name
      ).toBeTruthy()
      // The only step allowed between a mint and its user is publish-release's last-moment tag guard.
      const userOf = (mint) =>
        job.steps
          .slice(job.steps.indexOf(mint) + 1)
          .find((step) => step.name !== 'Verify release tag still matches the drafted source')
      expect(mints.map((mint) => userOf(mint).id ?? userOf(mint).name)).toEqual(TOKEN_USERS[name])
      for (const mint of mints) {
        expect(mint.uses).toBe(PINNED_ACTION)
        expect(mint.with).toEqual({
          'client-id': '${{ vars.RELEASE_APP_CLIENT_ID }}',
          'private-key': '${{ secrets.RELEASE_APP_PRIVATE_KEY }}',
          owner: '${{ github.repository_owner }}',
          repositories: '${{ github.event.repository.name }}',
          'permission-contents': 'write',
          'permission-workflows': 'write'
        })
        const user = userOf(mint)
        const tokenEnv = Object.values(user.env).find((value) =>
          value.includes(`steps.${mint.id}.`)
        )
        expect(tokenEnv).toBe(`\${{ steps.${mint.id}.outputs.token }}`)
        expect(JSON.stringify(user.env)).not.toContain('secrets.GITHUB_TOKEN')
        expect(user.run).not.toContain('${{')
      }
    }
  })

  it('pushes main on GITHUB_TOKEN and only the tag with the App header', () => {
    const push = releaseCut.jobs.cut.steps.find((step) => step.name === 'Push tag').run
    const [mainPush, tagPush] = push.split('release_auth=')
    expect(mainPush).toContain('git push origin "HEAD:refs/heads/main"')
    expect(mainPush).not.toContain('RELEASE_APP_TOKEN')
    expect(tagPush).toMatch(/GIT_CONFIG_VALUE_0=""[\s\S]*git push origin "\$TAG"\s*$/)
  })

  it.skipIf(process.platform === 'win32').each([
    ['missing client ID', '', 'true', 1],
    ['missing key', 'Iv23liE4ssrgbZYeHsXN', 'false', 1],
    ['configured', 'Iv23liE4ssrgbZYeHsXN', 'true', 0]
  ])('credential check fails closed: %s', (_name, clientId, hasKey, code) => {
    const step = releaseCut.jobs['publish-release'].steps[0]
    const result = runProcessSync({
      program: 'bash',
      args: ['-c', step.run],
      env: { ...process.env, RELEASE_APP_CLIENT_ID: clientId, HAS_RELEASE_APP_KEY: hasKey }
    })
    expect(result.code).toBe(code)
    expect(result.stdout).toContain(code ? '::error::' : '')
  })
})

describe('release builds check out the verified commit', () => {
  it('pins every tag checkout and reusable build to the cut release SHA, then asserts HEAD', () => {
    expect(readFileSync('.github/workflows/release-cut.yml', 'utf8')).not.toContain(
      'refs/tags/${{ needs.cut.outputs.tag }}'
    )
    let checkouts = 0
    for (const [name, job] of Object.entries(releaseCut.jobs)) {
      if (job.uses && job.with?.ref) {
        expect(job.with.ref, name).toBe('${{ needs.cut.outputs.release_sha }}')
      }
      for (const [index, step] of (job.steps ?? []).entries()) {
        if (!step.with?.ref?.includes('needs.cut')) {
          continue
        }
        checkouts += 1
        expect(step.with.ref, name).toBe('${{ needs.cut.outputs.release_sha }}')
        const verify = job.steps.slice(index + 1, index + 3)
        expect(
          verify.map((s) => s.name),
          name
        ).toContain('Verify checkout is the release commit')
      }
    }
    expect(checkouts).toBe(6)
  })

  it('pins the macOS build to the dispatched release SHA', async () => {
    const steps = macBuild.jobs['build-mac'].steps
    expect(steps[0].with.ref).toBe(
      '${{ inputs.qualification_only && github.sha || inputs.release_sha }}'
    )
    expect(steps[1].env.RELEASE_SHA).toBe('${{ inputs.release_sha }}')
    let body
    await dispatchReleaseMacBuildWorkflow(
      { owner: 'o', repo: 'r', request: async (_method, _path, value) => (body = value) },
      { releaseRunId: '1', tag: 'v1.2.3', releaseSha: 'a'.repeat(40), ref: 'main', workflow: 'w' }
    )
    expect(body.inputs.release_sha).toBe('a'.repeat(40))
    for (const step of steps) {
      expect(step.run ?? '', step.name).not.toContain('${{ inputs.')
    }
  })

  const verifyRun = releaseCut.jobs['create-release'].steps.find(
    (step) => step.name === 'Verify checkout is the release commit'
  ).run
  it.skipIf(process.platform === 'win32').each([
    ['matching', (head) => head, 0],
    ['moved', () => 'e'.repeat(40), 1],
    ['empty', () => '', 1]
  ])('HEAD assertion: %s', (_name, releaseSha, code) => {
    const head = runProcessSync({ program: 'git', args: ['rev-parse', 'HEAD'] }).stdout.trim()
    const result = runProcessSync({
      program: 'bash',
      args: ['-c', verifyRun],
      env: { ...process.env, RELEASE_SHA: releaseSha(head) }
    })
    expect(result.code).toBe(code)
  })
})
