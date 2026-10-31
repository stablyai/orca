import { describe, expect, it } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

describe('Windows installer process probe routing', () => {
  it.each([
    [],
    ['config/nsis/orca-process-check.nsh'],
    ['config/nsis/orca-installer-hooks.nsh'],
    ['config/scripts/nsis-process-check.test.mjs'],
    ['config/scripts/idle-cpu-process-sampling.mjs'],
    ['config/scripts/idle-cpu-process-sampling.test.mjs'],
    ['src/packages/process-host/src/run-process.ts'],
    ['config/vitest.config.ts'],
    ['config/scripts/vitest-host-ports-setup.ts'],
    ['config/scripts/ci-unit-files.mjs'],
    ['.github/actions/install-node-dependencies/action.yml'],
    ['.github/workflows/pr.yml'],
    ['package.json'],
    ['pnpm-lock.yaml'],
    ['src/renderer/src/App.tsx', 'config/nsis/orca-process-check.nsh']
  ])('routes Windows probe inputs to their containing job for %j', (...files) => {
    expect(classifyPrJobs(files)).toMatchObject({
      windows_process_probe: true,
      package_windows: true
    })
  })

  it('keeps packaging and full unit tests for unrelated application changes', () => {
    expect(classifyPrJobs(['src/renderer/src/App.tsx'])).toMatchObject({
      windows_process_probe: false,
      package_windows: true,
      test: true
    })
    expect(classifyPrJobs(['docs/README.md']).windows_process_probe).toBe(false)
  })
})
