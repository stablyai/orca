import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, matchesGlob, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcessSync } from './script-child-process.mjs'
import { shouldRunMobileReleaseChecks } from './mobile-release-check-scope.mjs'

const root = resolve(import.meta.dirname, '../..')
const workflow = parse(readFileSync(join(root, '.github/workflows/mobile.yml'), 'utf8'))
const steps = workflow.jobs.verify.steps
const detector = steps.find((step) => step.id === 'ruby-scope')
const directories = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each([
  'src/main/runtime/rpc/dispatcher.ts',
  'src/shared/rpc-contract/params.ts',
  'mobile/src/session/session.test.ts',
  'mobile/app/index.tsx',
  'mobile/src/theme.css',
  'mobile/src/session/README.md',
  'mobile/docs/release.md',
  'mobile/README.md',
  'docs/reference/mobile.md'
])('skips Ruby checks for application/documentation-only changes: %s', (file) => {
  expect(shouldRunMobileReleaseChecks([file])).toBe(false)
})

it.each([
  'mobile/fastlane/Fastfile',
  'mobile/fastlane/Appfile',
  'mobile/fastlane/ios_release_version.rb',
  'mobile/fastlane/ios_release_version_test.rb',
  'mobile/Gemfile',
  'mobile/Gemfile.lock',
  'mobile/.ruby-version',
  'mobile/.bundle/config',
  'mobile/app.json',
  'mobile/app.config.ts',
  'mobile/ios/Podfile',
  'mobile/package.json',
  'mobile/pnpm-lock.yaml',
  'mobile/scripts/release.mts',
  'mobile/src/release.rb',
  'mobile/src/release.json',
  'mobile/new-toolchain/input',
  'package.json',
  'pnpm-lock.yaml',
  '.github/workflows/mobile.yml',
  '.github/workflows/mobile-ios-release.yml',
  '.github/actions/install-node-dependencies/action.yml',
  'config/scripts/mobile-release-check-scope.mjs',
  'config/scripts/mobile-release-check-scope.test.mjs'
])('retains Ruby release coverage for changed or unknown inputs: %s', (file) => {
  expect(shouldRunMobileReleaseChecks([file])).toBe(true)
  expect(shouldRunMobileReleaseChecks(['mobile/src/view.tsx', file])).toBe(true)
})

it('runs Ruby checks when the changed-file evidence is empty', () => {
  expect(shouldRunMobileReleaseChecks([])).toBe(true)
})

it('gates only Ruby steps and keeps ordinary mobile validation unconditional', () => {
  expect(steps[0].with['fetch-depth']).toBe(2)
  expect(detector['working-directory']).toBe('.')
  expect(steps.indexOf(detector)).toBeGreaterThan(
    steps.findIndex((step) => step.uses === './.github/actions/install-node-dependencies')
  )
  const gated = steps.filter((step) => step.if !== undefined)
  expect(gated.map((step) => step.name)).toEqual([
    'Setup Ruby and fastlane',
    'Test iOS release version resolution',
    'Test TestFlight lane arguments',
    'Smoke-check the Fastfile'
  ])
  for (const step of gated) {
    expect(step.if).toBe("steps.ruby-scope.outputs.should_run != 'false'")
  }
  for (const name of [
    'Typecheck',
    'Typecheck tests (ratchet)',
    'Test',
    'Lint',
    'Check formatting'
  ]) {
    expect(steps.find((step) => step.name === name)?.if).toBeUndefined()
    expect(steps.some((step) => step.name === name)).toBe(true)
  }
  for (const file of [
    'config/scripts/mobile-release-check-scope.mjs',
    'config/scripts/mobile-release-check-scope.test.mjs',
    'config/scripts/pr-code-change-scope.mjs'
  ]) {
    expect(workflow.on.pull_request.paths.some((pattern) => matchesGlob(file, pattern))).toBe(true)
  }
  expect(workflow.jobs.verify.env.BUNDLE_FROZEN).toBe('true')
  expect(steps.find((step) => step.name === 'Setup Ruby and fastlane').with['bundler-cache']).toBe(
    true
  )
  expect(steps.find((step) => step.name === 'Smoke-check the Fastfile').run).toBe(
    'bundle exec fastlane lanes'
  )
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mobile-release-scope-'))
  directories.push(directory)
  const git = (...args) => {
    const result = runProcessSync({ program: 'git', args, cwd: directory })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  git('init', '--quiet')
  git('symbolic-ref', 'HEAD', 'refs/heads/main')
  git('config', 'user.name', 'Workflow fixture')
  git('config', 'user.email', 'workflow@example.invalid')
  const write = (file, content) => {
    mkdirSync(dirname(join(directory, file)), { recursive: true })
    writeFileSync(join(directory, file), content)
  }
  write('mobile/src/view.tsx', 'export const view = 1\n')
  write('mobile/fastlane/Fastfile', 'default_platform(:ios)\n')
  mkdirSync(join(directory, 'config/scripts'), { recursive: true })
  for (const file of [
    'package.json',
    'config/scripts/pr-code-change-scope.mjs',
    'config/scripts/mobile-release-check-scope.mjs'
  ]) {
    copyFileSync(join(root, file), join(directory, file))
  }
  const commit = () => {
    git('add', '-A')
    git(
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'fixture'
    )
  }
  commit()
  const detect = () => {
    const output = join(directory, 'github-output')
    const result = runProcessSync({
      program: 'bash',
      args: ['-e', '-c', detector.run],
      cwd: directory,
      env: { ...process.env, GITHUB_OUTPUT: output, RUNNER_TEMP: directory }
    })
    expect(result.code, result.stderr).toBe(0)
    return readFileSync(output, 'utf8')
  }
  return { directory, git, write, commit, detect }
}

describe.skipIf(process.platform === 'win32')('the Linux workflow detector command', () => {
  it('skips Ruby after a source-only commit', () => {
    const repo = fixture()
    repo.write('mobile/src/view.tsx', 'export const view = 2\n')
    repo.commit()
    expect(repo.detect()).toBe('should_run=false\n')
  })

  it('keeps a deleted release input when a rename moves it into an excluded directory', () => {
    const repo = fixture()
    repo.git('mv', 'mobile/fastlane/Fastfile', 'mobile/src/old-release.md')
    repo.commit()
    expect(repo.detect()).toBe('should_run=true\n')
  })

  it('runs Ruby when the merge parent is unavailable', () => {
    expect(fixture().detect()).toBe('should_run=true\n')
  })

  it('runs Ruby when the classifier cannot execute', () => {
    const repo = fixture()
    repo.write('mobile/src/view.tsx', 'export const view = 2\n')
    repo.commit()
    rmSync(join(repo.directory, 'config/scripts/mobile-release-check-scope.mjs'))
    expect(repo.detect()).toBe('should_run=true\n')
  })
})
