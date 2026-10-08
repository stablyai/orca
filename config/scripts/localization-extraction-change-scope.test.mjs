import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import localizationConfig from '../i18next.config'
import { affectsLocalizationExtraction } from './localization-extraction-change-scope.mjs'

it('pins the extractor inputs and exclusions used by the routing decision', () => {
  expect(localizationConfig.extract.input).toEqual(['src/**/*.{js,jsx,ts,tsx,mts,cts}'])
  expect(localizationConfig.extract.ignore).toEqual([
    '**/*.test.*',
    '**/*.spec.*',
    '**/__tests__/**',
    '**/__snapshots__/**',
    '**/assets/**'
  ])
})

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
  '.pnpmfile.cjs',
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
      'config/scripts/run-ssh-docker-e2e.mjs',
      'docs/reference/ci-runner-efficiency.md',
      'native/windows-registry/src/addon.cc'
    ])
  ).toBe(false)
})

it('preserves deleted and renamed inputs and falls back to extraction on detection failure', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/pr.yml', import.meta.url), 'utf8')
  )
  const step = workflow.jobs.preflight.steps.find(
    (candidate) => candidate.name === 'Verify localization extraction'
  )
  expect(step.env).toMatchObject({
    BASE_SHA: '${{ github.event.pull_request.base.sha }}'
  })
  // The base side comes from the merge ref's first parent, so the gate needs no merge base and
  // works on a shallow checkout. The payload head SHA is no longer read: HEAD is the merged tree
  // the gate is actually deciding about.
  expect(step.run).toContain('node config/scripts/git-pull-request-diff-base.mjs "$BASE_SHA"')
  expect(step.run).toContain('git diff --name-only --no-renames -z "$DIFF_BASE" HEAD')
  expect(step.run).not.toContain('--diff-filter')
  expect(step.run).toContain('&& [ "$scope" = false ]; then')
  expect(step.run).toMatch(/else\s+pnpm run verify:localization-extraction\s+fi/)
  expect(
    affectsLocalizationExtraction(['src/old-translations.ts', 'docs/moved-translations.ts'])
  ).toBe(true)
})
