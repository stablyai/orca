import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))

const mobileCiScopeDirectories = []
afterEach(() => {
  for (const directory of mobileCiScopeDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createMobileCiScopeRepository() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-mobile-ci-scope-'))
  mobileCiScopeDirectories.push(directory)
  const root = resolve(import.meta.dirname, '../../../..')
  for (const file of [
    'package.json',
    'config/scripts/workflow/source-routing/pr-code-change-scope.mjs',
    'config/scripts/workflow/source-routing/pr-package-test-paths.mjs',
    'config/scripts/workflow/source-routing/pr-layout-oracle-route.mjs',
    'config/scripts/workflow/source-routing/pr-shell-contract-prefixes.mjs',
    'config/scripts/workflow/source-routing/pr-xterm-patch-prefixes.mjs',
    'config/scripts/git/pr-diff-base/git-pull-request-diff-base.mjs',
    'config/scripts/workflow/source-routing/pr-e2e-source-routing.mjs',
    'config/scripts/workflow/source-routing/pr-browser-e2e-source-routes.mjs',
    'config/scripts/workflow/source-routing/pr-editor-preview-e2e-source-routes.mjs',
    'config/scripts/workflow/source-routing/pr-feature-area-e2e-source-routes.mjs',
    'config/scripts/workflow/source-routing/pr-plugin-e2e-source-routes.mjs',
    'config/scripts/workflow/source-routing/pr-wsl-e2e-source-routes.mjs',
    'config/scripts/ci/e2e-selection/ci-e2e-job-selection.mjs'
  ]) {
    mkdirSync(dirname(join(directory, file)), { recursive: true })
    copyFileSync(join(root, file), join(directory, file))
  }
  const git = (...args) => {
    const result = runProcessSync({ program: 'git', args, cwd: directory })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  const commit = () => {
    git('add', '-A')
    git(
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'scope input'
    )
    return git('rev-parse', 'HEAD')
  }
  git('init', '--quiet')
  git('config', 'user.name', 'Scope control')
  git('config', 'user.email', 'scope@example.invalid')
  const tool = join(directory, 'config/scripts/mobile-web/check-entry/run-mobile-ci-tests.mjs')
  mkdirSync(dirname(tool), { recursive: true })
  writeFileSync(tool, 'export const revision = 1\n')
  const base = commit()
  const detect = () => {
    const output = join(directory, 'github-output')
    const step = workflow.jobs.code_paths.steps.find((candidate) => candidate.id === 'filter')
    const result = runProcessSync({
      program: 'bash',
      args: [
        '-e',
        '-c',
        step.run.replace('${{ github.event.pull_request.base.sha }}', '$BASE_SHA')
      ],
      cwd: directory,
      env: {
        ...process.env,
        BASE_SHA: base,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_OUTPUT: output,
        ORCA_BACKGROUND_LAUNCH: '1'
      }
    })
    return { result, output }
  }
  return { directory, tool, commit, detect }
}

describe.skipIf(process.platform === 'win32')('Mobile CI complete Git change evidence', () => {
  it('admits an actual modification through the workflow detector', () => {
    const repo = createMobileCiScopeRepository()
    writeFileSync(repo.tool, 'export const revision = 2\n')
    repo.commit()
    const { result, output } = repo.detect()
    expect(result.code, result.stderr).toBe(0)
    expect(readFileSync(output, 'utf8')).toContain('mobile_ci_tools=true\n')
    expect(readFileSync(output, 'utf8')).toContain('test=true\n')
  })

  it.each(['deletion', 'type change'])('retains full root units for an actual %s', (change) => {
    const repo = createMobileCiScopeRepository()
    rmSync(repo.tool)
    if (change === 'type change') {
      symlinkSync('pr-code-change-scope.mjs', repo.tool)
    }
    repo.commit()
    const { result, output } = repo.detect()
    expect(result.code, result.stderr).toBe(0)
    expect(readFileSync(output, 'utf8')).toContain('mobile_ci_tools=false\n')
    expect(readFileSync(output, 'utf8')).toContain('test=true\n')
  })

  it('does not emit a passing classification when the Git evidence is unavailable', () => {
    const repo = createMobileCiScopeRepository()
    writeFileSync(repo.tool, 'export const revision = 2\n')
    repo.commit()
    expect(repo.detect().result.code).toBe(0)
    rmSync(join(repo.directory, 'github-output'))
    rmSync(join(repo.directory, '.git'), { recursive: true, force: true })
    const { result } = repo.detect()
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('not a git repository')
  })
})
