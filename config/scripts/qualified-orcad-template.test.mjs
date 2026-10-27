import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcessSync } from '@orca/process-host'
import { writeOrcadTemplateTestFixture } from './orcad-template-test-fixture.mjs'

const workflow = parse(readFileSync('.github/workflows/qualified-orcad-template.yml', 'utf8'))
const identity = workflow.jobs.cache.steps.find((step) => step.id === 'identity')

it('separates runner provenance, embedded CLI commits, workflow policy and daily requalification', () => {
  const root = mkdtempSync(join(tmpdir(), 'qualified-template-key-'))
  const policy = join(root, '.build', 'workflow-policy')
  const output = join(root, 'output')
  function run(program, args, cwd = root, env = {}) {
    const result = runProcessSync({ program, args, cwd, env: { ...process.env, ...env } })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  function commit(cwd, message) {
    run(
      'git',
      [
        '-c',
        'user.name=Template test',
        '-c',
        'user.email=template@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        message
      ],
      cwd
    )
  }
  function key(day = '20261021', profile = 'github-hosted') {
    run('bash', ['-c', `date() { printf '%s' "$TEST_DATE"; }; ${identity.run}`], root, {
      GITHUB_OUTPUT: output,
      TEST_DATE: day,
      RUNNER_PROFILE: profile
    })
    return readFileSync(output, 'utf8').trim().split('\n').at(-1)
  }
  try {
    run('git', ['init', '-q'])
    commit(root, 'first source commit')
    mkdirSync(join(policy, '.github'), { recursive: true })
    run('git', ['init', '-q'], policy)
    writeFileSync(join(policy, '.github', 'policy'), 'first')
    run('git', ['add', '.github'], policy)
    commit(policy, 'first workflow policy')
    const originalTree = run('git', ['rev-parse', 'HEAD^{tree}'])
    const initial = key()
    expect(key()).toBe(initial)
    expect(initial).toContain('-github-hosted-')
    expect(key('20261021', 'fast')).not.toBe(initial)
    commit(root, 'same tree with a different embedded CLI commit')
    expect(run('git', ['rev-parse', 'HEAD^{tree}'])).toBe(originalTree)
    const nextCommit = key()
    expect(nextCommit).not.toBe(initial)
    writeFileSync(join(policy, '.github', 'policy'), 'changed')
    run('git', ['add', '.github'], policy)
    commit(policy, 'changed workflow policy')
    const nextPolicy = key()
    expect(nextPolicy).not.toBe(nextCommit)
    expect(key('20261022')).not.toBe(nextPolicy)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('qualifies cache misses and permits cache publication only after the full matrix succeeds', () => {
  expect(workflow.jobs.qualify.if).toBe("needs.cache.outputs.hit != 'true'")
  expect(workflow.jobs.qualify.uses).toBe('./.github/workflows/node-server-tests.yml')
  expect(workflow.jobs.qualify.with).toMatchObject({
    build_template: true,
    fast_runners: '${{ inputs.fast_runners }}'
  })
  expect(workflow.jobs.save.needs).toContain('qualify')
  expect(workflow.jobs.save.if).toBe("needs.qualify.result == 'success'")
  const restore = workflow.jobs.cache.steps.find((step) => step.id === 'restore')
  expect(restore.with['restore-keys']).toBeUndefined()
  const validate = workflow.jobs.cache.steps.find((step) => step.id === 'validate')
  expect(validate.run).toContain('verifyPackagedOrcadTemplate')
  expect(validate.run).toContain('assertNotDarkBuild')
})

it('keeps SignPath on GitHub runners and isolates Blacksmith qualification caches', () => {
  const release = parse(readFileSync('.github/workflows/release-cut.yml', 'utf8'))
  const adhoc = parse(readFileSync('.github/workflows/adhoc-mac-build.yml', 'utf8'))
  expect(workflow.on.workflow_call.inputs.fast_runners.default).toBe(true)
  expect(release.jobs['orcad-template'].uses).toBe(
    './.github/workflows/qualified-orcad-template.yml'
  )
  expect(release.jobs['orcad-template'].with).toEqual({
    ref: 'refs/tags/${{ needs.cut.outputs.tag }}',
    fast_runners: false
  })
  expect(adhoc.jobs['orcad-template'].with.fast_runners).toBe(true)
  expect(identity.env.RUNNER_PROFILE).toBe(
    "${{ inputs.fast_runners && 'fast' || 'github-hosted' }}"
  )
  for (const name of ['cache', 'save']) {
    expect(workflow.jobs[name]['runs-on']).toBe(
      "${{ inputs.fast_runners && 'blacksmith-2vcpu-ubuntu-2404' || 'ubuntu-latest' }}"
    )
  }
})

it.each(['valid', 'corrupt', 'dark'])(
  'validates restored bytes and requalifies an unsafe template: %s',
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'qualified-template-restore-'))
    const output = join(root, 'output')
    try {
      symlinkSync(
        resolve('config'),
        join(root, 'config'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      const template = await writeOrcadTemplateTestFixture(join(root, 'out'))
      if (kind === 'corrupt') {
        writeFileSync(join(template, 'out/mobile-web/index.html'), 'mutated')
      } else if (kind === 'dark') {
        writeFileSync(join(template, 'ORCA_LAYOUT_OWNER_MAIN'), 'dark build')
      }
      const validate = workflow.jobs.cache.steps.find((step) => step.id === 'validate')
      const result = runProcessSync({
        program: 'bash',
        args: ['-e', '-c', validate.run],
        cwd: root,
        env: { ...process.env, GITHUB_OUTPUT: output }
      })
      expect(result.code, result.stderr).toBe(0)
      if (kind === 'valid') {
        expect(readFileSync(output, 'utf8').trim()).toBe('valid=true')
        expect(existsSync(template)).toBe(true)
      } else {
        expect(existsSync(output)).toBe(false)
        expect(existsSync(template)).toBe(false)
        expect(result.stdout).toContain('qualifying a fresh build')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
