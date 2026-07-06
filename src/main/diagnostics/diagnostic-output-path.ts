import { app } from 'electron'
import { join } from 'node:path'
import {
  DIAGNOSTIC_OUTPUT_PATH_ERROR,
  parseSafeDiagnosticBundleOutputPath
} from '../../shared/diagnostic-bundle-output-path-policy'

export function defaultDiagnosticBundleOutputPath(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '')
    .replace('T', '-')
  return join(getDiagnosticBundleOutputDirectory(), `orca-diagnostics-${stamp}.zip`)
}

export function resolveDiagnosticBundleOutputPath(output: string | undefined): string {
  if (!output || output.trim().length === 0) {
    return defaultDiagnosticBundleOutputPath()
  }
  const segments = parseSafeDiagnosticBundleOutputPath(output)
  if (!segments) {
    throw new Error(DIAGNOSTIC_OUTPUT_PATH_ERROR)
  }
  return join(getDiagnosticBundleOutputDirectory(), ...segments)
}

export function getDiagnosticBundleOutputDirectory(): string {
  return join(app.getPath('logs'), 'diagnostics')
}
