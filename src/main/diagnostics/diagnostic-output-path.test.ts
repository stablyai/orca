import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const { appRoot } = vi.hoisted(() => ({
  appRoot: 'orca-test-root'
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => `${appRoot}/${name}`
  }
}))

describe('resolveDiagnosticBundleOutputPath', () => {
  it('resolves relative output names under the diagnostics directory', async () => {
    const { resolveDiagnosticBundleOutputPath } = await import('./diagnostic-output-path')

    const output = resolveDiagnosticBundleOutputPath('support/orca-diagnostics.zip')
    expect(output).toContain(join(appRoot, 'logs'))
    expect(output.endsWith(join('diagnostics', 'support', 'orca-diagnostics.zip'))).toBe(true)
  })

  it('rejects output paths outside the diagnostics directory', async () => {
    const { DIAGNOSTIC_OUTPUT_PATH_ERROR } =
      await import('../../shared/diagnostic-bundle-output-path-policy')
    const { resolveDiagnosticBundleOutputPath } = await import('./diagnostic-output-path')

    expect(() => resolveDiagnosticBundleOutputPath('../orca-diagnostics.zip')).toThrow(
      DIAGNOSTIC_OUTPUT_PATH_ERROR
    )
    expect(() => resolveDiagnosticBundleOutputPath('C:\\tmp\\orca-diagnostics.zip')).toThrow(
      DIAGNOSTIC_OUTPUT_PATH_ERROR
    )
  })
})
