import { app } from 'electron'

export function collectAppDiagnosticSummary(
  orcaChannel: 'stable' | 'rc' | 'dev'
): Record<string, unknown> {
  return {
    appVersion: app.getVersion(),
    appName: app.getName(),
    orcaChannel,
    packaged: app.isPackaged,
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    nodeVersion: process.versions.node,
    v8Version: process.versions.v8,
    pathRoles: {
      // Why: real app paths can include usernames; diagnostics only need role labels.
      logs: 'app-logs',
      userData: 'app-user-data',
      crashDumps: 'app-crash-dumps'
    }
  }
}
