// The release App key only exists in a job that runs workflow-commit code and verifies the tag first.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflowText = readFileSync('.github/workflows/release-cut.yml', 'utf8')
const workflow = parse(workflowText)
const verifier = resolve('config/scripts/release/operations/verify-release-tag.sh')
const BOT = 'github-actions[bot]'
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'
// Actions sets every step env key, empty when the expression is empty.
const VERIFY_ENV = {
  PREPARED_TAG: '',
  PREPARED_RECOVERED: '',
  VERSION: '',
  RECOVERED: '',
  SOURCE_SHA: '',
  EVENT_NAME: 'workflow_dispatch',
  SLOT: '',
  VERIFY: ''
}
const PINNED = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/

describe('release-cut job split', () => {
  const cut = workflow.jobs.cut
  const prepare = workflow.jobs.prepare

  // Each privileged job, the step its App token serves, and that step's required predecessor (if any).
  const PRIVILEGED = {
    'recover-drafts': ['publish_drafts'],
    cut: ['Push main and the release tag'],
    'create-release': [
      'draft',
      'Record the run that created the draft',
      'Upload the release record'
    ],
    'publish-release': ['Verify release tag still matches the drafted source', 'Publish release']
  }

  it('keeps the App key out of every job but the privileged ones', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const privileged = name in PRIVILEGED
      expect(job.environment === 'release', name).toBe(privileged)
      expect(JSON.stringify(job).includes('RELEASE_APP_PRIVATE_KEY'), name).toBe(privileged)
    }
    expect(prepare.needs).toBe('recover-drafts')
    expect(prepare.permissions).toEqual({ contents: 'read' })
    expect(cut.needs).toBe('prepare')
  })

  it.each(Object.entries(PRIVILEGED))(
    '%s runs only pinned actions and workflow-commit code, with hooks off',
    (name, users) => {
      const job = workflow.jobs[name]
      expect(job.env).toEqual({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: '/dev/null'
      })
      const checkouts = job.steps.filter((step) => step.uses?.startsWith('actions/checkout'))
      expect(checkouts[0].with.ref).toBe('${{ github.workflow_sha }}')
      for (const checkout of checkouts) {
        expect(checkout.with['persist-credentials']).toBe(false)
        // Any other checkout is the release source, read as data from its own directory.
        expect(checkout === checkouts[0] || checkout.with.path === 'candidate').toBe(true)
      }
      const rootIsWorkflow = checkouts[0].with.path === undefined
      for (const step of job.steps) {
        if (step.uses) {
          expect(step.uses, step.name).toMatch(PINNED)
          expect(workflowText).toMatch(new RegExp(`uses: ${step.uses} # v\\d+\\.\\d+\\.\\d+\\n`))
          expect(step.uses, step.name).not.toMatch(/setup-node|install/)
        }
        const run = (step.run ?? '')
          .split('\n')
          .filter((line) => !line.trim().startsWith('#'))
          .join('\n')
        expect(run, step.name).not.toMatch(/\b(npm|npx|pnpm|yarn)\b/)
        // Inline `node -e` is workflow code; any script must come from the workflow checkout.
        for (const [, script] of run.matchAll(/node (?!-e )"?([^"\s]+)/g)) {
          const fromWorkflow =
            /^\$(RELEASE_SCRIPTS|GITHUB_WORKSPACE\/workflow)\//.test(script) ||
            (rootIsWorkflow && script.startsWith('config/scripts/'))
          expect(fromWorkflow, `${step.name}: ${script}`).toBe(true)
        }
      }
      // The token is minted right before the steps that use it, and only they see it.
      const mintIndex = job.steps.findIndex((step) => step.id === 'release-app-token')
      const mint = job.steps[mintIndex]
      expect(mint.with).toEqual({
        'client-id': '${{ vars.RELEASE_APP_CLIENT_ID }}',
        'private-key': '${{ secrets.RELEASE_APP_PRIVATE_KEY }}',
        owner: '${{ github.repository_owner }}',
        repositories: '${{ github.event.repository.name }}',
        'permission-contents': 'write',
        'permission-workflows': 'write'
      })
      const after = job.steps.slice(mintIndex + 1).map((step) => step.id ?? step.name)
      expect(after).toEqual(users)
      const tokenUsers = job.steps.filter((step) =>
        JSON.stringify(step.env ?? {}).includes('steps.release-app-token.outputs.token')
      )
      expect(tokenUsers.length).toBe(1)
      expect(
        job.steps[mintIndex - 1].name === 'Require release App credentials' ||
          name === 'publish-release'
      ).toBe(true)
    }
  )

  it('runs the version script from the workflow checkout in the privileged cut', () => {
    expect(cut.steps.find((step) => step.id === 'version').env.RELEASE_SCRIPTS).toBe(
      '${{ github.workspace }}/workflow'
    )
  })

  it('mints the App token only after the tag is verified, and only for the tag push', () => {
    const ids = cut.steps.map((step) => step.id ?? step.name)
    const mint = cut.steps.find((step) => step.uses?.startsWith('actions/create-github-app-token'))
    expect(ids.indexOf('verify')).toBeLessThan(ids.indexOf('release-app-token'))
    expect(mint.with).toMatchObject({
      'client-id': '${{ vars.RELEASE_APP_CLIENT_ID }}',
      'permission-contents': 'write',
      'permission-workflows': 'write'
    })
    const users = cut.steps.filter((step) => JSON.stringify(step).includes('release-app-token.'))
    expect(users.map((step) => step.name)).toEqual(['Push main and the release tag'])
    const push = users[0].run
    expect(push).toContain('push_with "$MAIN_TOKEN" "$RELEASE_SHA:refs/heads/main"')
    expect(push).toContain('push_with "$RELEASE_APP_TOKEN" "$REF:refs/tags/$TAG"')
    expect(push).toContain('GIT_CONFIG_KEY_0=core.hooksPath')
  })

  it('never runs source lifecycle scripts while preparing the tag', () => {
    const bump = prepare.steps.find((step) => step.id === 'tag').run
    expect(bump).toMatch(/npm version "\$VERSION" .*--ignore-scripts/)
    // Both jobs compute the version with the same script.
    expect(cut.steps.find((step) => step.id === 'version').run).toBe(
      prepare.steps.find((step) => step.id === 'version').run
    )
  })

  it.skipIf(process.platform === 'win32').each([
    ['a different fresh tag', { VERSION: '1.2.3', PREPARED_TAG: 'v1.2.4' }],
    ['a fresh tag where recovery is due', { RECOVERED: 'v1.2.3', PREPARED_TAG: 'v1.2.3' }],
    ['a recovered tag where a fresh one is due', { VERSION: '1.2.3', PREPARED_RECOVERED: 'v1.2.2' }]
  ])('refuses a prepared tag the workflow does not compute: %s', (_name, env) => {
    const step = cut.steps.find((s) => s.id === 'verify')
    const result = runProcessSync({
      program: 'bash',
      args: ['-c', step.run],
      env: { ...VERIFY_ENV, ...env }
    })
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('::error::')
  })
})

describe('homebrew bump after draft recovery', () => {
  it('reads the recovered RC tag from the job that publishes drafts, which runs without a cut', () => {
    const [producer, job] = Object.entries(workflow.jobs).find(([, candidate]) =>
      (candidate.steps ?? []).some((step) =>
        step.run?.includes('publication/publish-complete-draft-releases.mjs')
      )
    )
    const step = job.steps.find((candidate) =>
      candidate.run?.includes('publication/publish-complete-draft-releases.mjs')
    )
    const [output] = Object.entries(job.outputs).find(
      ([, value]) => value === `\${{ steps.${step.id}.outputs.latest_published_tag }}`
    )
    // A recovery-only run has no tag to push, so cut (and everything after it) is skipped.
    expect(producer).not.toBe('cut')
    expect([job.needs ?? []].flat()).not.toContain('cut')
    const bump = workflow.jobs['homebrew-bump-published-rc-draft']
    expect(bump.needs).toEqual([producer])
    expect(bump.if).toBe(`\${{ needs.${producer}.outputs.${output} != '' }}`)
    expect(bump.with.tag).toBe(`\${{ needs.${producer}.outputs.${output} }}`)
    expect(workflowText).not.toContain('needs.cut.outputs.latest_published_rc_tag')
  })
})

describe.skipIf(process.platform === 'win32')('verify-release-tag.sh', () => {
  let dir
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: BOT,
    GIT_AUTHOR_EMAIL: BOT_EMAIL,
    GIT_COMMITTER_NAME: BOT,
    GIT_COMMITTER_EMAIL: BOT_EMAIL,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1'
  }
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim()
  const writePackage = (pkg) =>
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

  // Mirrors release-cut: source commit, then a package.json-only release commit and an annotated tag.
  function repo({
    version = '1.2.3',
    extraFile = false,
    otherField = false,
    tagger = env,
    releaseJson = null,
    lightweight = false
  } = {}) {
    dir = mkdtempSync(join(tmpdir(), 'release-tag-verify-'))
    git('init', '-q')
    writePackage({ name: 'orca', version: '1.2.2' })
    git('add', '.')
    git('commit', '-qm', 'source')
    const source = git('rev-parse', 'HEAD')
    writePackage({ name: otherField ? 'evil' : 'orca', version })
    if (releaseJson !== null) {
      writeFileSync(join(dir, 'package.json'), releaseJson)
    }
    if (extraFile) {
      writeFileSync(join(dir, 'payload.sh'), 'echo hi\n')
    }
    git('add', '.')
    git('commit', '-qm', 'release: v1.2.3')
    execFileSync('git', lightweight ? ['tag', 'v1.2.3'] : ['tag', '-a', 'v1.2.3', '-m', 'v1.2.3'], {
      cwd: dir,
      env: { ...tagger, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    })
    return source
  }
  const verify = (source, message = 'release: v1.2.3', ref = 'refs/tags/v1.2.3') =>
    runProcessSync({
      program: 'bash',
      args: [verifier, ref, '1.2.3', source, ...(message === null ? [] : [message])],
      cwd: dir
    })

  it('accepts the tag release-cut creates and prints its commit', () => {
    const source = repo()
    const result = verify(source)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(git('rev-parse', 'v1.2.3^{commit}'))
  })

  it.each([
    ['an extra file', { extraFile: true }],
    ['another package.json change', { otherField: true }],
    ['a different version', { version: '1.2.4' }],
    ['another tagger', { tagger: { ...env, GIT_COMMITTER_NAME: 'mallory' } }]
  ])('refuses a fresh tag with %s', (_name, options) => {
    const source = repo(options)
    expect(verify(source).code).toBe(1)
  })

  it('refuses a fresh tag with another message, a lightweight tag, or another source', () => {
    const source = repo()
    expect(verify(source, 'release: v1.2.3 [rc-slot:x]').code).toBe(1)
    git('tag', 'light', 'v1.2.3^{commit}')
    expect(verify(source, 'release: v1.2.3', 'refs/tags/light').code).toBe(1)
    expect(verify('f'.repeat(40)).code).toBe(1)
  })

  it('holds a recovered tag to the same tag and content rules', () => {
    expect(verify(repo(), null).code).toBe(0)
    expect(verify(repo({ extraFile: true }), null).code).toBe(1)
    expect(verify(repo({ tagger: { ...env, GIT_COMMITTER_NAME: 'person' } }), null).code).toBe(1)
    expect(verify(repo({ lightweight: true }), null).code).toBe(1)
  })

  it.each([
    [
      'a duplicate version key',
      '{\n  "name": "orca",\n  "version": "1.2.3",\n  "version": "1.2.3"\n}\n'
    ],
    [
      'an escaped key that parses the same',
      '{\n  "name": "orca",\n  "\\u0076ersion": "1.2.3"\n}\n'
    ],
    ['reformatting', '{"name":"orca","version":"1.2.3"}\n']
  ])('refuses a package.json that only parses like the expected one: %s', (_name, releaseJson) => {
    expect(verify(repo({ releaseJson })).code).toBe(1)
  })

  it('carries the prepared tag through a git bundle into the privileged checkout', () => {
    const source = repo()
    const bundleDir = join(dir, 'release-tag-bundle')
    git(
      '-c',
      'core.hooksPath=/dev/null',
      'bundle',
      'create',
      'release-tag.bundle',
      'refs/tags/v1.2.3',
      `^${source}`
    )
    execFileSync('mkdir', ['-p', bundleDir])
    execFileSync('mv', [join(dir, 'release-tag.bundle'), bundleDir])
    git('tag', '-d', 'v1.2.3')
    git('reset', '-q', '--hard', source)
    git('reflog', 'expire', '--expire=now', '--all')
    git('gc', '-q', '--prune=now')
    const output = join(dir, 'out')
    writeFileSync(output, '')
    const step = workflow.jobs.cut.steps.find((s) => s.id === 'verify')
    const result = runProcessSync({
      program: 'bash',
      args: ['-c', step.run],
      cwd: dir,
      env: {
        ...process.env,
        ...VERIFY_ENV,
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: output,
        VERSION: '1.2.3',
        PREPARED_TAG: 'v1.2.3',
        SOURCE_SHA: source,
        EVENT_NAME: 'workflow_dispatch',
        VERIFY: verifier
      }
    })
    expect(result.code, result.stderr + result.stdout).toBe(0)
    expect(readFileSync(output, 'utf8')).toContain('ref=refs/release-candidate/v1.2.3')
    expect(readFileSync(output, 'utf8')).toMatch(/release_sha=[0-9a-f]{40}/)
  })
})
