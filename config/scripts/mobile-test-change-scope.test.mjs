import { readFileSync } from 'node:fs'
import { matchesGlob } from 'node:path'
import { parse } from 'yaml'
import { expect, it } from 'vitest'
import { shouldRunMobileTests } from './mobile-test-change-scope.mjs'

function workflowIncludes(paths, files) {
  return files.some((file) =>
    paths.reduce((included, pattern) => {
      const excluded = pattern.startsWith('!')
      return matchesGlob(file, excluded ? pattern.slice(1) : pattern) ? !excluded : included
    }, false)
  )
}

it.each([
  'docs/ci.md',
  'mobile/docs/release.md',
  'mobile/README.md',
  'mobile/Gemfile.lock',
  'mobile/fastlane/Fastfile',
  '.github/workflows/mobile-ios-release.yml',
  'config/scripts/pr-code-change-scope.mjs',
  'config/scripts/pr-package-test-paths.mjs',
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
      'src/main/runtime/structured-attention-original-delivery.test-fixture.ts',
      'pnpm-lock.yaml'
    ]) {
      expect(workflowIncludes(paths, [file])).toBe(true)
    }
    expect(workflowIncludes(paths, ['src/packages/unrelated/src/index.ts'])).toBe(false)
  }
})

it('honors ordered exclusions and later re-inclusion when matching workflow paths', () => {
  const paths = ['src/**', '!src/**/*.test.ts', 'src/retained.test.ts']
  expect(workflowIncludes(paths, ['src/removed.test.ts'])).toBe(false)
  expect(workflowIncludes(paths, ['src/retained.test.ts'])).toBe(true)
})

it.each([
  'src/shared/model-id-label.test.ts',
  'src/shared/nested/view.test.tsx',
  'src/shared/nested/module.test.js',
  'src/shared/nested/view.test.jsx',
  'src/shared/nested/module.test.cjs',
  'src/shared/nested/module.test.mjs',
  'src/shared/nested/module.test.cts',
  'src/shared/nested/module.test.mts',
  'src/packages/process-host/src/run-process.test.ts',
  'src/main/agent-launch/dispatch.test.ts',
  'src/main/runtime/rpc/dispatcher.test.ts',
  'src/main/runtime/runtime-rpc/server.test.ts',
  'src/main/runtime/agent-session-store.test.ts',
  'src/main/native-chat/agent-session-wire/history.test.ts'
])('skips desktop suites on PRs and main, including removal: %s', (file) => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/mobile.yml', import.meta.url), 'utf8')
  )
  expect(shouldRunMobileTests([file])).toBe(false)
  expect(shouldRunMobileTests([file, 'mobile/docs/ci.md'])).toBe(false)
  for (const paths of [workflow.on.pull_request.paths, workflow.on.push.paths]) {
    expect(workflowIncludes(paths, [file])).toBe(false)
    expect(workflowIncludes(paths, [file, 'src/shared/changed.ts'])).toBe(true)
    expect(workflowIncludes(paths, [file, 'mobile/src/changed.test.ts'])).toBe(true)
    // A rename is represented by the removed and added names, so moving a suite into source runs.
    expect(workflowIncludes(paths, [file, file.replace('.test.', '.')])).toBe(true)
  }
  expect(shouldRunMobileTests([file, 'src/shared/changed.ts'])).toBe(true)
  expect(shouldRunMobileTests([file, file.replace('.test.', '.')])).toBe(true)
})

it.each([
  'mobile/src/changed.test.ts',
  'mobile/src/changed.test.tsx',
  'src/shared/project-section-parity.test-fixture.ts',
  'src/shared/fixtures/recording.json',
  'src/main/runtime/rpc/methods/agent-launch.test-fixture.ts',
  'src/main/runtime/agent-session-record-store-test-harness.ts',
  'src/packages/process-host/tsconfig.test.json',
  'src/packages/process-host/vitest.config.ts',
  'src/packages/process-host/package.json',
  'pnpm-lock.yaml',
  'mobile/pnpm-lock.yaml',
  'config/mobile-ci.vitest.config.mjs',
  'config/scripts/run-mobile-ci-tests.mjs',
  'config/.bun-version',
  '.github/workflows/mobile.yml'
])('retains mobile suites, shared fixtures and toolchain inputs: %s', (file) => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/mobile.yml', import.meta.url), 'utf8')
  )
  expect(shouldRunMobileTests([file])).toBe(true)
  for (const paths of [workflow.on.pull_request.paths, workflow.on.push.paths]) {
    expect(workflowIncludes(paths, [file])).toBe(true)
  }
})

it('retains unknown suite paths and noncanonical traversal evidence', () => {
  expect(shouldRunMobileTests(['unknown/module.test.ts'])).toBe(true)
  expect(shouldRunMobileTests(['src/unknown/module.test.ts'])).toBe(true)
  expect(shouldRunMobileTests(['src/shared/../main/module.test.ts'])).toBe(true)
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

it('overlaps both typechecks with tests and collects their failures before the summary', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/mobile.yml', import.meta.url), 'utf8')
  )
  const steps = workflow.jobs.verify.steps
  const install = steps.findIndex((step) => step.name === 'Install dependencies')
  const test = steps.findIndex((step) => step.name === 'Test')
  const summary = steps.findIndex((step) => step.name === 'Summarize RPC recording changes')
  const waits = steps.filter((step) => step.wait !== undefined)
  expect(waits).toHaveLength(1)
  const [wait] = waits
  expect(wait.wait).toEqual(['production-types', 'test-types', 'ruby-tools'])
  expect(wait.if).toBeUndefined()
  expect(steps.indexOf(wait)).toBeGreaterThan(test)
  expect(steps.indexOf(wait)).toBeLessThan(summary)
  for (const id of ['production-types', 'test-types']) {
    const step = steps.find((candidate) => candidate.id === id)
    expect(step.background).toBe(true)
    expect(step['continue-on-error']).toBeUndefined()
    expect(step.if).toBeUndefined()
    expect(steps.indexOf(step)).toBeGreaterThan(install)
    expect(steps.indexOf(step)).toBeLessThan(test)
    expect(step.run).toMatch(/^node /)
  }
  const ruby = steps.find((step) => step.id === 'ruby-tools')
  expect(ruby.uses).toBe('ruby/setup-ruby@v1')
  expect(ruby.background).toBe(true)
  expect(ruby.if).toBe("steps.ruby-scope.outputs.should_run != 'false'")
  expect(ruby['continue-on-error']).toBeUndefined()
  expect(steps.indexOf(ruby)).toBeLessThan(install)
})
