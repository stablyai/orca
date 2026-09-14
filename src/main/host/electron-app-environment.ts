import { app } from 'electron'
import type { AppEnvironment, AppPathName, AppProcessMetric } from '../../shared/app-environment'

/**
 * Electron-backed AppEnvironment for the desktop app: a pass-through to
 * `electron.app`, so desktop path, version and lifecycle behaviour is unchanged.
 */
export class ElectronAppEnvironment implements AppEnvironment {
  getPath(name: AppPathName): string {
    return app.getPath(name)
  }

  getAppPath(): string {
    return app.getAppPath()
  }

  getVersion(): string {
    return app.getVersion()
  }

  isPackaged(): boolean {
    return app.isPackaged
  }

  onWillQuit(handler: () => void): void {
    app.on('will-quit', handler)
  }

  exit(code = 0): void {
    app.exit(code)
  }

  getAppMetrics(): AppProcessMetric[] {
    // Electron's ProcessMetric is structurally compatible with the loose mirror
    // (pid plus optional cpu/memory); the nominal types differ, hence the cast.
    return app.getAppMetrics() as unknown as AppProcessMetric[]
  }
}
