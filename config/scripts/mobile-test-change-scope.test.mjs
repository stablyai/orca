import { readFileSync } from 'node:fs'
import { matchesGlob } from 'node:path'
import { parse } from 'yaml'
import { expect, it } from 'vitest'
import { shouldRunMobileTests } from './mobile-test-change-scope.mjs'

it.each([
  'docs/ci.md',
  'mobile/docs/release.md',
  'mobile/README.md',
  'mobile/Gemfile.lock',
  'mobile/fastlane/Fastfile',
  '.github/workflows/mobile-ios-release.yml',
  'config/scripts/pr-code-change-scope.mjs',
  'config/scripts/mobile-release-check-scope.test.mjs'
])('skips only known non-test inputs: %s', (file) => {
  expect(shouldRunMobileTests([file])).toBe(false)
  expect(shouldRunMobileTests([file, 'mobile/src/changed.ts'])).toBe(true)
})

it.each([
  'mobile/src/view.tsx',
  'mobile/app/_layout.tsx',
  'mobile/scripts/check.ts',
  'mobile/rpc-foundation/goldens/recording.json',
  'mobile/vitest.config.ts',
  'mobile/vitest.setup.ts',
  'mobile/pnpm-lock.yaml',
  'pnpm-lock.yaml',
  'src/main/runtime/runtime-rpc.ts',
  'src/shared/protocol-version.ts',
  'src/packages/process-host/src/run-process.ts',
  '.github/workflows/mobile.yml',
  '.github/actions/install-node-dependencies/action.yml',
  'config/scripts/mobile-test-change-scope.mjs',
  'unknown-input',
  'mobile/docs/../../src/source.ts'
])('retains source, fixtures, toolchain, selector and unknown changes: %s', (file) => {
  expect(shouldRunMobileTests([file])).toBe(true)
})

it('retains tests on missing evidence and a move out of the source tree', () => {
  expect(shouldRunMobileTests([])).toBe(true)
  expect(shouldRunMobileTests(['mobile/src/deleted.ts', 'mobile/docs/moved.ts'])).toBe(true)
})

it('runs Mobile Checks for shared modules, process-host tooling and the root lockfile on PRs and main', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/mobile.yml', import.meta.url), 'utf8')
  )
  for (const paths of [workflow.on.pull_request.paths, workflow.on.push.paths]) {
    for (const file of [
      'src/shared/any/module.ts',
      'src/packages/process-host/src/run-process.ts',
      'src/packages/process-host/package.json',
      'pnpm-lock.yaml'
    ]) {
      expect(paths.some((pattern) => matchesGlob(file, pattern))).toBe(true)
    }
    expect(
      paths.some((pattern) => matchesGlob('src/packages/unrelated/src/index.ts', pattern))
    ).toBe(false)
  }
})

it('skips only tests, after successful detection, and retains all other mobile gates', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/mobile.yml', import.meta.url), 'utf8')
  )
  const steps = workflow.jobs.verify.steps
  expect(workflow.on.pull_request.paths).toContain('config/scripts/mobile-test-change-scope*')
  const detector = steps.find((step) => step.id === 'test-scope')
  expect(detector.run).toContain('git diff --name-only --no-renames -z HEAD^1 HEAD')
  expect(detector.run.match(/should_run=true/g)).toHaveLength(2)
  expect(steps.find((step) => step.name === 'Test').if).toBe(
    "steps.test-scope.outputs.should_run != 'false'"
  )
  for (const name of ['Typecheck', 'Typecheck tests (ratchet)', 'Lint', 'Check formatting']) {
    expect(steps.find((step) => step.name === name).if).toBeUndefined()
  }
})
