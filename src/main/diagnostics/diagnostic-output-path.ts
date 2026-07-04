import { app } from 'electron'
import { isAbsolute, join, resolve } from 'node:path'

export function defaultDiagnosticBundleOutputPath(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '')
    .replace('T', '-')
  return join(app.getPath('logs'), 'diagnostics', `orca-diagnostics-${stamp}.zip`)
}

export function resolveDiagnosticBundleOutputPath(output: string | undefined): string {
  if (!output || output.trim().length === 0) {
    return defaultDiagnosticBundleOutputPath()
  }
  return isAbsolute(output) ? output : resolve(process.cwd(), output)
}
