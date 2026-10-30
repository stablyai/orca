import { join } from 'node:path'
import { expect, it } from 'vitest'
import { planChangedChecks, splitUnitTestInputs } from './check-changed-selection.mjs'

const scriptsDir = join(import.meta.dirname)
const plan = (files) => planChangedChecks(files, { scriptsDir })
const checkNames = (files) => plan(files).checks.map((check) => check.name)

it('skips typecheck, tests, and verifiers for a docs-only change but keeps the format gate', () => {
  expect(plan(['docs/STYLEGUIDE.md'])).toEqual({
    staticAnalysis: true,
    typecheckProjects: [],
    unitTests: { related: [], colocated: [] },
    checks: []
  })
})

it('routes generated-artifact inputs to their verifiers', () => {
  expect(checkNames(['src/renderer/src/i18n/locales/fr.json'])).toEqual(
    expect.arrayContaining(['localization catalogs', 'localization coverage'])
  )
  expect(checkNames(['src/main/runtime/rpc/methods/worktree.ts'])).toContain('rpc params catalog')
  expect(checkNames(['skills/orca-cli/SKILL.md'])).toEqual([
    'bundled skill guides',
    'skill bundle manifest'
  ])
})

it('limits typecheck to the projects a tree reaches', () => {
  expect(plan(['src/renderer/src/App.tsx']).typecheckProjects).toEqual([
    'config/tsconfig.node.json',
    'config/tsconfig.tc.web.json'
  ])
  expect(plan(['src/packages/process-host/src/run-process.ts']).typecheckProjects).toEqual([
    'config/tsconfig.node.json',
    'config/tsconfig.tc.web.json',
    'config/tsconfig.tc.cli.json',
    'src/packages/process-host/tsconfig.test.json'
  ])
})

it('keeps Vitest full-run triggers out of the related set and runs their colocated tests', () => {
  const listDirectory = (directory) =>
    directory === 'config/scripts/'
      ? ['foo.mjs', 'foo.test.mjs', 'foo.windows.test.mjs', 'foobar.test.mjs']
      : []
  expect(
    splitUnitTestInputs(
      ['package.json', 'config/scripts/foo.mjs', 'config/scripts/bar.test.mjs', 'src/main/a.ts'],
      listDirectory
    )
  ).toEqual({
    related: ['src/main/a.ts'],
    colocated: [
      'config/scripts/bar.test.mjs',
      'config/scripts/foo.test.mjs',
      'config/scripts/foo.windows.test.mjs'
    ]
  })
})

it('selects Node for its exact cloud support dependency without routing unrelated cloud sources', () => {
  expect(
    plan(['cloud/apps/push/src/push-owner-integration.test-fixture.ts']).typecheckProjects
  ).toEqual(['config/tsconfig.node.json'])
  for (const file of [
    'cloud/apps/push/src/push-owner-live.test-fixture.ts',
    'cloud/apps/push/src/push-owner-integration.test-fixture.tsx',
    'cloud/apps/push/src/index.ts'
  ]) {
    expect(plan([file]).typecheckProjects).toEqual([])
  }
})

it('selects runner drift verification for each dedicated entry, config and launch source', () => {
  for (const file of [
    'src/main/runtime/push/push-owner-live.test-fixture.ts',
    'mobile/src/notifications/push-owner-live.test-fixture.ts',
    'cloud/apps/push/src/push-owner-live.test-fixture.ts',
    'src/main/runtime/push/push-owner-companions.test-fixture.ts',
    '.github/workflows/push-owner-integration.yml',
    'config/push-owner-root.vitest.config.mjs',
    'config/push-owner-mobile.vitest.config.mjs',
    'config/push-owner-cloud.vitest.config.mjs',
    'mobile/vitest.config.ts'
  ]) {
    expect(checkNames([file]), file).toContain('test file runners')
  }
})
