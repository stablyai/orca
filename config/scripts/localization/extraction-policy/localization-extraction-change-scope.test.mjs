import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

it.skipIf(process.platform === 'win32')(
  'executes workflow routing for ignored changes, deleted and renamed inputs, and detection failures',
  () => {
    const workflow = parse(
      readFileSync(new URL('../../../../.github/workflows/pr.yml', import.meta.url), 'utf8')
    )
    const step = workflow.jobs.preflight.steps.find(
      (candidate) => candidate.name === 'Verify localization extraction'
    )
    const scratch = mkdtempSync(join(tmpdir(), 'orca-localization-routing-'))
    const directory = join(scratch, 'checkout')
    mkdirSync(directory)
    const calls = join(scratch, 'extraction-calls')
    const run = (program, args, env = process.env) => {
      const result = runProcessSync({ program, args, cwd: directory, env })
      expect(result.code, result.stderr).toBe(0)
      return result.stdout.trim()
    }
    const git = (...args) => run('git', args)
    const write = (path, contents) => {
      mkdirSync(dirname(join(directory, path)), { recursive: true })
      writeFileSync(join(directory, path), contents)
    }
    const commit = () => {
      git('add', '-A')
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        'fixture'
      )
      return git('rev-parse', 'HEAD')
    }
    const route = (base, expected, boundary = '', overrides = {}) => {
      writeFileSync(calls, '')
      run(
        'bash',
        [
          '-e',
          '-o',
          'pipefail',
          '-c',
          `
        node() { command "$ORCA_TEST_NODE" "$@"; }
        bun() { printf '%s\n' "$@" >> "$ORCA_TEST_EXTRACTION_CALLS"; }
        ${boundary}
        ${step.run}
      `
        ],
        {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_TEST_NODE: process.execPath,
          ORCA_TEST_EXTRACTION_CALLS: calls,
          RUNNER_TEMP: scratch,
          BASE_SHA: base,
          GITHUB_EVENT_NAME: 'pull_request',
          PREFLIGHT_PHASE_SELECTED: 'true',
          PREFLIGHT_PRIOR_SUCCESS: 'true',
          ...overrides
        }
      )
      expect(readFileSync(calls, 'utf8')).toBe(
        expected
          ? 'config/scripts/localization/source-extraction/verify-localization-extraction.mjs\n'
          : ''
      )
    }

    try {
      git('init', '--quiet')
      for (const script of [
        'config/scripts/git/pr-diff-base/git-pull-request-diff-base.mjs',
        'config/scripts/localization/extraction-policy/localization-extraction-change-scope.mjs'
      ]) {
        const relative = script
        mkdirSync(dirname(join(directory, relative)), { recursive: true })
        copyFileSync(new URL(`../../../../${script}`, import.meta.url), join(directory, relative))
      }
      write('src/deleted.ts', "translate('deleted')")
      write('src/renamed.ts', "translate('renamed')")
      write('src/example.test.ts', '// ignored')
      let base = commit()
      route(base, false)

      write('src/example.test.ts', '// still ignored')
      const ignored = commit()
      route(base, false)
      base = ignored

      rmSync(join(directory, 'src/deleted.ts'))
      const deleted = commit()
      route(base, true)
      base = deleted

      mkdirSync(join(directory, 'docs'))
      git('mv', 'src/renamed.ts', 'docs/renamed.ts')
      const renamed = commit()
      route(base, true)
      base = renamed
      route(base, false)
      route(base, true, 'git() { if [ "$1" = diff ]; then return 1; fi; command git "$@"; }')
      route(
        base,
        true,
        `node() {
        if [ "$1" = config/scripts/localization/extraction-policy/localization-extraction-change-scope.mjs ]; then return 1; fi
        command "$ORCA_TEST_NODE" "$@"
      }`
      )
      route(deleted, false, '', { PREFLIGHT_PHASE_SELECTED: 'false' })
      route(deleted, false, '', { PREFLIGHT_PRIOR_SUCCESS: 'false' })
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
)
