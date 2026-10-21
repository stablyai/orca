import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcessSync } from '@orca/process-host'

const workflow = parse(readFileSync('.github/workflows/adhoc-orcad-template.yml', 'utf8'))
const identity = workflow.jobs.cache.steps.find((step) => step.id === 'identity')

it('separates embedded CLI commits, workflow policy changes and daily requalification', () => {
  const root = mkdtempSync(join(tmpdir(), 'adhoc-template-key-'))
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
  function key(day = '20261021') {
    run('bash', ['-c', `date() { printf '%s' "$TEST_DATE"; }; ${identity.run}`], root, {
      GITHUB_OUTPUT: output,
      TEST_DATE: day
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
  expect(workflow.jobs.qualify.with).toMatchObject({ build_template: true, fast_runners: true })
  expect(workflow.jobs.save.needs).toContain('qualify')
  expect(workflow.jobs.save.if).toBe("needs.qualify.result == 'success'")
  const restore = workflow.jobs.cache.steps.find((step) => step.id === 'restore')
  expect(restore.with['restore-keys']).toBeUndefined()
  const validate = workflow.jobs.cache.steps.find((step) => step.id === 'validate')
  expect(validate.run).toContain('verifyPackagedOrcadTemplate')
  expect(validate.run).toContain('assertNotDarkBuild')
})
