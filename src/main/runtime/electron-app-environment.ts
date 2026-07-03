import { app } from 'electron'
import type { AppEnvironment, AppPathName, AppProcessMetric } from '../../shared/app-environment'

/**
 * Electron-backed AppEnvironment used by the desktop app. Thin pass-through to
 * `electron.app` so desktop path/version/lifecycle behavior is unchanged.
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

  quit(): void {
    app.quit()
  }

  exit(code = 0): void {
    app.exit(code)
  }

  relaunch(): void {
    app.relaunch()
  }

  getAppMetrics(): AppProcessMetric[] {
    // electron's ProcessMetric is structurally compatible with our loose mirror
    // (pid + optional cpu/memory); cast via unknown since the nominal types differ.
    return app.getAppMetrics() as unknown as AppProcessMetric[]
  }
}
