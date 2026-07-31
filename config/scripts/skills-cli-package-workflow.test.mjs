import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))

describe('packaged skills CLI PR gates', () => {
  it('builds and executes the Windows packaged CLI', () => {
    const job = workflow.jobs.package_windows
    const buildStep = job.steps.find((step) => step.name === 'Build package inputs')
    const prepareStep = job.steps.find((step) => step.name === 'Prepare Electron native runtime')
    const packageStep = job.steps.find((step) => step.name === 'Package unpacked app')
    const smokeStep = job.steps.find((step) => step.name === 'Smoke packaged CLI')

    expect(job['runs-on']).toBe('windows-2022')
    expect(buildStep.run).toBe('pnpm run build:release')
    expect(prepareStep.run).toBe('node config/scripts/ensure-native-runtime.mjs --runtime=electron')
    expect(packageStep.run).toContain('electron-builder')
    expect(packageStep.run).toContain('--dir')
    expect(packageStep.env.ORCA_REUSE_PREPARED_NATIVE_RUNTIME).toBe('1')
    expect(smokeStep.run).toBe(
      'node config/scripts/smoke-packaged-cli.mjs --app-dir=dist/win-unpacked'
    )

    const aggregateStep = workflow.jobs.verify.steps.find(
      (step) => step.name === 'Require successful checks'
    )
    expect(aggregateStep.env.PACKAGE_WINDOWS).toBe('${{ needs.package_windows.result }}')
    expect(aggregateStep.run).toContain('"$PACKAGE_WINDOWS"')
  })
})
