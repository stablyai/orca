// Builds check out the commit release-cut recorded, never the movable tag name.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { dispatchReleaseMacBuildWorkflow } from '../operations/run-release-mac-build-workflow.mjs'

const releaseCutText = readFileSync('.github/workflows/release-cut.yml', 'utf8')
const releaseCut = parse(releaseCutText)
const macBuild = parse(readFileSync('.github/workflows/release-mac-build.yml', 'utf8'))
const RELEASE_SHA = '${{ needs.cut.outputs.release_sha }}'

describe('release builds check out the verified commit', () => {
  it('pins every tag checkout and reusable build to the cut release SHA, then asserts HEAD', () => {
    expect(releaseCutText).not.toContain('refs/tags/${{ needs.cut.outputs.tag }}')
    let checkouts = 0
    for (const [name, job] of Object.entries(releaseCut.jobs)) {
      if (job.uses && job.with?.ref) {
        expect(job.with.ref, name).toBe(RELEASE_SHA)
      }
      for (const [index, step] of (job.steps ?? []).entries()) {
        if (!step.with?.ref?.includes('needs.cut')) {
          continue
        }
        checkouts += 1
        expect(step.with.ref, name).toBe(RELEASE_SHA)
        const next = job.steps.slice(index + 1, index + 3).map((s) => s.name)
        expect(next, name).toContain('Verify checkout is the release commit')
      }
    }
    // Draft creation reads the commit through the API, so it no longer checks out the source.
    expect(checkouts).toBe(5)
  })

  it('pins the macOS build to the dispatched release SHA and keeps inputs out of shell', async () => {
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

  const verifyRun = releaseCut.jobs['terminal-rendering-golden'].steps.find(
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

describe('mac build binding to its parent run', () => {
  it('names a parent job after the cut tag and the dispatched mac run, as the mac build expects', () => {
    const binding = releaseCut.jobs['mac-build-binding']
    expect(binding.name).toBe(
      'mac release build ${{ needs.build-mac.outputs.run_id }} for ${{ needs.cut.outputs.tag }}'
    )
    expect(binding.needs).toEqual(['cut', 'build-mac'])
    expect(binding.if).toBeUndefined()
    expect(binding.permissions).toEqual({})
    expect(releaseCut.jobs['build-mac'].outputs.run_id).toBe('${{ steps.dispatch.outputs.run_id }}')
    const verify = macBuild.jobs['build-mac'].steps[1]
    expect(verify.run).toContain('export BINDING_JOB="mac release build $GITHUB_RUN_ID for $TAG"')
    expect(verify.run).toContain('jobs?filter=latest&per_page=100')
    expect(Number(verify.env.BINDING_ATTEMPTS) * Number(verify.env.BINDING_POLL_SECONDS)).toBe(600)
  })
})

describe('Windows retried bash commands', () => {
  const steps = releaseCut.jobs.build.steps
  const require = steps.find((step) => step.name === 'Require Git Bash for the release upload')
  const pattern = new RegExp(require.run.match(/-notmatch '([^']+)'/)[1])

  it('puts Git Bash first and requires it right before every bash retry that can run on Windows', () => {
    let guarded = 0
    for (const [index, step] of steps.entries()) {
      if (!step.uses?.startsWith('nick-fields/retry@') || step.with?.shell !== 'bash') {
        continue
      }
      if (step.if?.includes("matrix.platform == 'linux-x64'")) {
        continue
      }
      guarded += 1
      expect(steps[index - 1], step.name).toBe(require)
      expect(steps[index - 2].name).toBe('Put Git Bash first on PATH for the release upload')
      expect(steps[index - 2].if).toBe(step.if)
      expect(require.if).toBe(step.if)
      expect(steps[index - 2].run).toContain("Join-Path $env:ProgramFiles 'Git\\bin'")
      expect(steps[index - 2].run).toContain('Add-Content -LiteralPath $env:GITHUB_PATH')
    }
    expect(guarded).toBe(1)
    // Resolves bash as the retry action does: through Node's child_process.
    expect(require.run).toContain("execFileSync('bash', ['--version']")
  })

  it.each([
    ['GNU bash, version 5.2.37(1)-release (x86_64-pc-msys)', true],
    ['GNU bash, version 5.2.37(1)-release (aarch64-pc-msys)', true],
    ['GNU bash, version 5.1.16(1)-release (x86_64-pc-linux-gnu)', false],
    ['Windows Subsystem for Linux has no installed distributions.', false],
    ['', false]
  ])('accepts only Git for Windows bash: %s', (version, ok) => {
    expect(pattern.test(version)).toBe(ok)
  })
})

describe('release workflow shell inputs', () => {
  it('passes step, job and input values to shell only through env', () => {
    for (const [file, wf] of [
      ['release-cut.yml', releaseCut],
      ['release-mac-build.yml', macBuild]
    ]) {
      for (const [job, { steps = [] }] of Object.entries(wf.jobs)) {
        for (const step of steps) {
          for (const script of [step.run, step.with?.command]) {
            // matrix, runner and github values are workflow constants; outputs and inputs are data.
            expect(script ?? '', `${file} ${job} ${step.name}`).not.toMatch(
              /\$\{\{[^}]*\b(steps|needs|inputs)\./
            )
          }
        }
      }
    }
  })
})

describe.skipIf(process.platform === 'win32')('release commit binding', () => {
  let dir
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t'
  }
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()

  // An origin whose v1.2.3 tag points at `tagged`, and a clone checked out at `checkedOut`.
  function setup({ tagOther = false } = {}) {
    dir = mkdtempSync(join(tmpdir(), 'release-binding-'))
    const origin = join(dir, 'origin')
    git(dir, 'init', '-q', origin)
    git(origin, 'commit', '-q', '--allow-empty', '-m', 'release: v1.2.3')
    const release = git(origin, 'rev-parse', 'HEAD')
    git(origin, 'commit', '-q', '--allow-empty', '-m', 'other')
    git(origin, 'tag', '-a', 'v1.2.3', '-m', 'v1.2.3', tagOther ? 'HEAD' : release)
    git(dir, 'clone', '-q', origin, 'clone')
    const clone = join(dir, 'clone')
    git(clone, 'checkout', '-q', '--detach', release)
    return { clone, release }
  }
  // gh stub: answers `gh api [--paginate] <path> --jq <filter>` by running the filter with jq over a fixture.
  function stubGh({ run, jobs, releases }) {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run))
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify({ jobs }))
    writeFileSync(join(dir, 'releases.json'), JSON.stringify(releases))
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env bash
set -euo pipefail
path='' filter=''
shift
while (($#)); do
  case "$1" in
    --paginate) ;;
    --jq) filter="$2"; shift ;;
    *) path="$1" ;;
  esac
  shift
done
case "$path" in
  */jobs[?]*) fixture=jobs ;;
  */releases[?]*) fixture=releases ;;
  *) fixture=run ;;
esac
jq -r "$filter" "${dir}/$fixture.json"
`
    )
    chmodSync(join(bin, 'gh'), 0o755)
    return `${bin}:${process.env.PATH}`
  }
  const macVerify = macBuild.jobs['build-mac'].steps[1].run
  const runningCut = {
    path: '.github/workflows/release-cut.yml',
    head_branch: 'main',
    status: 'in_progress'
  }
  const bindingJob = { name: 'mac release build 777 for v1.2.3' }
  const draft = { tag_name: 'v1.2.3', name: 'v1.2.3', draft: true }
  const accepted = { run: runningCut, jobs: [{ name: 'build-mac' }, bindingJob], releases: [draft] }

  it.each([
    ['the live tag, its draft and the run that dispatched it', {}, {}, 0],
    ['a tag pointing at another commit', { tagOther: true }, {}, 1],
    ['a finished release-cut', {}, { run: { ...runningCut, status: 'completed' } }, 1],
    ['a release-cut on another branch', {}, { run: { ...runningCut, head_branch: 'x' } }, 1],
    ['another workflow', {}, { run: { ...runningCut, path: '.github/workflows/x.yml' } }, 1],
    [
      'a parent that dispatched another mac run',
      {},
      { jobs: [{ name: 'mac release build 778 for v1.2.3' }] },
      1
    ],
    [
      'a parent that cut another tag',
      {},
      { jobs: [{ name: 'mac release build 777 for v1.2.4' }] },
      1
    ],
    ['a published release', {}, { releases: [{ ...draft, draft: false }] }, 1],
    [
      'a published release named like the tag',
      {},
      { releases: [draft, { tag_name: 'x', name: '1.2.3', draft: false }] },
      1
    ],
    ['no release', {}, { releases: [{ ...draft, tag_name: 'v1.2.4', name: 'v1.2.4' }] }, 1],
    ['two drafts for the tag', {}, { releases: [draft, draft] }, 1]
  ])('mac build accepts only %s', (_name, options, answers, code) => {
    const { clone, release } = setup(options)
    const result = runProcessSync({
      program: 'bash',
      args: ['-c', macVerify],
      cwd: clone,
      env: {
        ...env,
        PATH: stubGh({ ...accepted, ...answers }),
        RELEASE_SHA: release,
        TAG: 'v1.2.3',
        RELEASE_RUN_ID: '42',
        GITHUB_RUN_ID: '777',
        GITHUB_REPOSITORY: 'o/r',
        BINDING_ATTEMPTS: '2',
        BINDING_POLL_SECONDS: '0'
      }
    })
    expect(result.code, result.stdout + result.stderr).toBe(code)
  })

  // The privileged cut records release_sha only from the verifier's output.
  it('fails loudly when the release tag cannot be recorded', () => {
    const { clone, release } = setup()
    const verify = releaseCut.jobs.cut.steps.find((step) => step.id === 'verify').run
    expect(releaseCut.jobs.cut.outputs.release_sha).toBe('${{ steps.verify.outputs.release_sha }}')
    const output = join(dir, 'out')
    writeFileSync(output, '')
    const result = runProcessSync({
      program: 'bash',
      args: ['-c', verify],
      cwd: clone,
      env: {
        ...env,
        GITHUB_OUTPUT: output,
        PREPARED_TAG: '',
        PREPARED_RECOVERED: 'v9.9.9',
        VERSION: '',
        RECOVERED: 'v9.9.9',
        SOURCE_SHA: release,
        EVENT_NAME: 'workflow_dispatch',
        SLOT: '',
        VERIFY: resolve('config/scripts/release/operations/verify-release-tag.sh')
      }
    })
    expect(result.code).toBe(1)
    expect(readFileSync(output, 'utf8')).toBe('')
  })
})
