import { readFileSync } from 'node:fs'
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
  '.pnpmfile.cjs',
  '.github/workflows/pr.yml',
  '.github/actions/install-node-dependencies/action.yml'
])('retains extraction when an input changes: %s', (path) => {
  expect(affectsLocalizationExtraction([path])).toBe(true)
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
  const step = workflow.jobs.static_analysis.steps.find(
    (candidate) => candidate.name === 'Verify localization extraction'
  )
  expect(step.env).toEqual({
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
