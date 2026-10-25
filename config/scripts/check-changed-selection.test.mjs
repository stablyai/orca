import { join } from 'node:path'
import { expect, it } from 'vitest'
import { planChangedChecks, splitUnitTestInputs } from './check-changed-selection.mjs'

const scriptsDir = join(import.meta.dirname)
const plan = (files) => planChangedChecks(files, { scriptsDir })
const checkNames = (files) => plan(files).checks.map((check) => check.name)

it('skips typecheck, tests, and verifiers for a docs-only change but keeps the format gate', () => {
  expect(plan(['docs/reference/git-workflow.md'])).toEqual({
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
