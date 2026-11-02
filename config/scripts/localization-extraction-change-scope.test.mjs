import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { affectsLocalizationExtraction } from './localization-extraction-change-scope.mjs'

it.each([
  'src/renderer/src/components/Example.tsx',
  'src/main/notifications.ts',
  'src/renderer/src/i18n/locales/en.json',
  'config/i18next.config.ts',
  'config/scripts/verify-localization-extraction.mjs',
  'config/scripts/localization-extraction-change-scope.mjs',
  'config/patches/i18next-cli.patch',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'config/tsconfig.web.json',
  '.npmrc',
  'config/pnpmfile.cjs',
  '.github/workflows/pr.yml',
  '.github/actions/install-node-dependencies/action.yml'
])('retains extraction when an input changes: %s', (path) => {
  expect(affectsLocalizationExtraction([path])).toBe(true)
})

it.each([
  'src/main/notifications.test.ts',
  'src/main/notifications.spec.ts',
  'src/renderer/src/components/Example.test.tsx',
  'src/main/example.test.js',
  'src/main/example.spec.jsx',
  'src/main/example.test.mts',
  'src/main/example.spec.cts',
  'src/.test.ts',
  'src/.spec.ts',
  'src/__tests__/notifications.ts',
  'src/main/__tests__/nested/notifications.ts',
  'src/main/__snapshots__/notifications.ts'
])('avoids extraction for an explicitly ignored test source: %s', (path) => {
  expect(affectsLocalizationExtraction([path])).toBe(false)
})

it.each([
  'src/main/notifications-test.ts',
  'src/main/notifications.test-support.ts',
  'src/main/notifications.specification.ts',
  'src/main/notifications.TEST.ts',
  'src/main/.test./notifications.ts',
  'src/main/notifications.test/notifications.ts',
  'src/main/__tests__-support/notifications.ts',
  'src/main/__snapshots__-support/notifications.ts',
  'src/main/__tests__.ts',
  'src/main/assets/notifications.ts',
  'src/main/__tests__/en.json',
  'src/renderer/src/i18n/locales/en.test.json',
  'src/main/notifications.test.unknown'
])('retains extraction for catalogs, assets and near-match source paths: %s', (path) => {
  expect(affectsLocalizationExtraction([path])).toBe(true)
})

it('retains mixed changes and both sides of source-to-test renames', () => {
  const ignored = 'src/main/notifications.test.ts'
  expect(affectsLocalizationExtraction([ignored, 'src/main/notifications.ts'])).toBe(true)
  expect(affectsLocalizationExtraction(['src/main/notifications.ts', ignored])).toBe(true)
  expect(affectsLocalizationExtraction([ignored, 'config/i18next.config.ts'])).toBe(true)
  expect(affectsLocalizationExtraction([ignored, 'src/renderer/src/i18n/locales/en.json'])).toBe(
    true
  )
  expect(affectsLocalizationExtraction([ignored, 'src/main/notifications.spec.ts'])).toBe(false)
})

it('avoids extraction for unrelated CI, documentation, and native changes', () => {
  expect(
    affectsLocalizationExtraction([
      '.github/workflows/e2e.yml',
      'config/scripts/run-terminal-scale-perf-e2e.mjs',
      'docs/reference/ci-runner-efficiency.md',
      'native/windows-registry/src/addon.cc'
    ])
  ).toBe(false)
})

it.skipIf(process.platform === 'win32')(
  'executes workflow routing for ignored changes, deleted and renamed inputs, and detection failures',
  () => {
    const workflow = parse(
      readFileSync(new URL('../../.github/workflows/pr.yml', import.meta.url), 'utf8')
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
        expected ? 'config/scripts/verify-localization-extraction.mjs\n' : ''
      )
    }

    try {
      git('init', '--quiet')
      for (const script of ['git-pull-request-diff-base', 'localization-extraction-change-scope']) {
        const relative = `config/scripts/${script}.mjs`
        mkdirSync(dirname(join(directory, relative)), { recursive: true })
        copyFileSync(new URL(`./${script}.mjs`, import.meta.url), join(directory, relative))
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
        if [ "$1" = config/scripts/localization-extraction-change-scope.mjs ]; then return 1; fi
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
