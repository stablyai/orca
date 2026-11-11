import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcessSync } from '@orca/process-host'

const root = resolve(import.meta.dirname, '../../../..')
const workflow = parse(readFileSync(join(root, '.github/workflows/mobile.yml'), 'utf8'))
const steps = workflow.jobs.verify.steps
const detector = steps.find((step) => step.id === 'ruby-scope')
const directories = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(detectorStep = detector) {
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
    'config/scripts/workflow/source-routing/pr-code-change-scope.mjs',
    'config/scripts/workflow/source-routing/pr-package-test-paths.mjs',
    'config/scripts/workflow/source-routing/pr-layout-oracle-route.mjs',
    'config/scripts/workflow/source-routing/pr-shell-contract-prefixes.mjs',
    'config/scripts/workflow/source-routing/pr-xterm-patch-prefixes.mjs',
    'config/scripts/mobile-web/check-entry/mobile-release-check-scope.mjs',
    'config/scripts/mobile-web/check-entry/mobile-test-change-scope.mjs'
  ]) {
    mkdirSync(dirname(join(directory, file)), { recursive: true })
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
      args: ['-e', '-c', detectorStep.run],
      cwd: directory,
      env: { ...process.env, GITHUB_OUTPUT: output, RUNNER_TEMP: directory }
    })
    expect(result.code, result.stderr).toBe(0)
    return readFileSync(output, 'utf8')
  }
  return { directory, git, write, commit, detect }
}

describe.skipIf(process.platform === 'win32')('the Linux workflow detector command', () => {
  it('keeps a deleted release input when a rename moves it into an excluded directory', () => {
    const repo = fixture()
    repo.git('mv', 'mobile/fastlane/Fastfile', 'mobile/src/old-release.md')
    repo.commit()
    expect(repo.detect()).toBe('should_run=true\n')
  })

  it('runs Ruby when the classifier cannot execute', () => {
    const repo = fixture()
    repo.write('mobile/src/view.tsx', 'export const view = 2\n')
    repo.commit()
    rmSync(
      join(repo.directory, 'config/scripts/mobile-web/check-entry/mobile-release-check-scope.mjs')
    )
    expect(repo.detect()).toBe('should_run=true\n')
  })
})

describe.skipIf(process.platform === 'win32')('the mobile test detector command', () => {
  const testDetector = steps.find((step) => step.id === 'test-scope')
  it('skips release-only changes while retaining source changes', () => {
    const repo = fixture(testDetector)
    repo.write('mobile/fastlane/Fastfile', 'default_platform(:android)\n')
    repo.commit()
    expect(repo.detect()).toBe('should_run=false\n')
    repo.write('mobile/src/view.tsx', 'export const view = 2\n')
    repo.commit()
    expect(repo.detect()).toBe('should_run=false\nshould_run=true\n')
  })
  it('retains tests after source moves into a documentation directory', () => {
    const repo = fixture(testDetector)
    repo.git('mv', 'mobile/src/view.tsx', 'mobile/README.md')
    repo.commit()
    expect(repo.detect()).toBe('should_run=true\n')
  })
  it('retains tests when the diff is unavailable', () => {
    expect(fixture(testDetector).detect()).toBe('should_run=true\n')
  })
  it('retains tests when the classifier cannot execute', () => {
    const repo = fixture(testDetector)
    repo.write('mobile/fastlane/Fastfile', 'default_platform(:android)\n')
    repo.commit()
    rmSync(
      join(repo.directory, 'config/scripts/mobile-web/check-entry/mobile-test-change-scope.mjs')
    )
    expect(repo.detect()).toBe('should_run=true\n')
  })
})
