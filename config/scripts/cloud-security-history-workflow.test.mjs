import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcessSync } from '../../src/shared/child-process/run-process'

const workflow = parse(
  readFileSync(new URL('../../.github/workflows/cloud-verify.yml', import.meta.url), 'utf8')
)
const steps = workflow.jobs.security.steps
const history = steps.find((step) => step.name === 'Fetch complete scan history')

it('fetches both merge parents and deleted content without unrelated branches or tags', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-cloud-history-'))
  const source = join(directory, 'source')
  const checkout = join(directory, 'checkout')
  const run = (program, args, cwd, env = process.env) => {
    const result = runProcessSync({ program, args, cwd, env })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  const git = (args, cwd = source) => run('git', args, cwd)
  const commit = (message) => {
    git(['add', '-A'])
    git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message])
    return git(['rev-parse', 'HEAD'])
  }

  try {
    run('git', ['init', '--quiet', source], directory)
    git(['checkout', '-b', 'main'])
    git(['config', 'user.name', 'CI test'])
    git(['config', 'user.email', 'ci@example.invalid'])
    mkdirSync(join(source, 'cloud'))
    writeFileSync(join(source, 'cloud', 'removed.txt'), 'historical-scan-marker\n')
    const original = commit('historical content')
    rmSync(join(source, 'cloud', 'removed.txt'))
    writeFileSync(join(source, 'cloud', 'current.txt'), 'current\n')
    commit('delete historical content')
    git(['checkout', '-b', 'feature'])
    writeFileSync(join(source, 'cloud', 'feature.txt'), 'feature-parent-marker\n')
    commit('feature parent')
    git(['checkout', 'main'])
    writeFileSync(join(source, 'cloud', 'base.txt'), 'base-parent-marker\n')
    commit('base parent')
    git(['-c', 'commit.gpgsign=false', 'merge', '--no-ff', 'feature', '-m', 'PR merge'])
    const sha = git(['rev-parse', 'HEAD'])
    const expectedHistory = git(['rev-list', 'HEAD']).split('\n').sort()
    const expectedPatch = git(['log', '--format=%H', '-p', 'HEAD', '--', 'cloud'])
    git(['checkout', '-b', 'unrelated', original])
    writeFileSync(join(source, 'unrelated.txt'), 'unrelated-object\n')
    const unrelated = commit('unrelated branch')
    git(['tag', 'unrelated-tag'])
    git(['checkout', 'main'])

    run(
      'git',
      ['clone', '--depth=1', '--no-tags', '--branch', 'main', pathToFileURL(source).href, checkout],
      directory
    )
    expect(git(['rev-list', '--count', 'HEAD'], checkout)).toBe('1')
    run('bash', ['-e', '-c', history.run], checkout, { ...process.env, GITHUB_SHA: sha })

    expect(git(['rev-list', 'HEAD'], checkout).split('\n').sort()).toEqual(expectedHistory)
    const actualPatch = git(['log', '--format=%H', '-p', 'HEAD', '--', 'cloud'], checkout)
    expect(actualPatch).toBe(expectedPatch)
    expect(actualPatch).toContain('historical-scan-marker')
    expect(actualPatch).toContain('feature-parent-marker')
    expect(actualPatch).toContain('base-parent-marker')
    expect(git(['tag', '--list'], checkout)).toBe('')
    expect(
      runProcessSync({ program: 'git', args: ['cat-file', '-e', unrelated], cwd: checkout }).code
    ).not.toBe(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('completes history before scanning the same HEAD and Cloud paths', () => {
  expect(steps[0].with['fetch-depth']).toBe(1)
  expect(history['working-directory']).toBe('.')
  const scanIndex = steps.findIndex((step) => step.run?.includes('gitleaks@'))
  expect(steps.indexOf(history)).toBeLessThan(scanIndex)
  expect(steps[scanIndex].run).toContain(
    '--log-opts="HEAD -- cloud :(glob).github/workflows/cloud-*.yml .github/actions/cloud-sql-rollout-lease"'
  )
  expect(steps.some((step) => step.run?.includes('trufflehog@'))).toBe(true)
})
