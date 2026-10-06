import { describe, expect, it } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

describe('standalone CLI install matrix routing', () => {
  it.each(['src/cli/index.ts', 'config/scripts/build-standalone-cli.mjs'])(
    'runs the matrix and the packages when %s changes',
    (file) => {
      expect(classifyPrJobs([file])).toMatchObject({
        standalone_cli: true,
        package: true,
        package_windows: true
      })
    }
  )

  it.each([
    'config/scripts/smoke-standalone-cli-tarball.mjs',
    'config/standalone-cli/bin-orca.cjs'
  ])('runs only the matrix when its tooling %s changes', (file) => {
    expect(classifyPrJobs([file])).toMatchObject({
      standalone_cli: true,
      package: false,
      package_windows: false
    })
  })

  it('skips the matrix for main-process code', () => {
    expect(classifyPrJobs(['src/main/index.ts'])).toMatchObject({
      standalone_cli: false,
      package: true,
      package_windows: true
    })
  })

  it('runs the Windows lane when the named-pipe compat gate test changes', () => {
    expect(classifyPrJobs(['src/cli/runtime/client-standalone-compat-gate.test.ts'])).toMatchObject(
      { package_windows: true }
    )
  })
})
