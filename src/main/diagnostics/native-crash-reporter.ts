import { app, crashReporter } from 'electron'
import os from 'node:os'
import { ensureNativeCrashDumpDirectory } from './native-crash-dump-directory'
import { resolveDiagnosticOrcaChannel } from '../observability/diagnostic-upload-endpoint'

let started = false

export function startNativeCrashReporter(): string | null {
  if (started) {
    return null
  }
  const crashDumps = ensureNativeCrashDumpDirectory()
  app.setPath('crashDumps', crashDumps)
  crashReporter.start({
    uploadToServer: false,
    ignoreSystemCrashHandler: false,
    globalExtra: {
      app_version: app.getVersion(),
      orca_channel: resolveDiagnosticOrcaChannel(),
      platform: os.platform(),
      arch: os.arch(),
      os_release: os.release(),
      electron_version: process.versions.electron ?? 'unknown',
      chrome_version: process.versions.chrome ?? 'unknown',
      schema_version: '1'
    }
  })
  started = true
  return crashDumps
}

export function resetNativeCrashReporterForTest(): void {
  started = false
}
