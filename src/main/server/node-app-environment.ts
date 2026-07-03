import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import type { AppEnvironment, AppPathName, AppProcessMetric } from '../../shared/app-environment'

/**
 * Plain-Node AppEnvironment for the headless `@stablyai/orca-server`. Resolves paths from
 * env + os instead of `electron.app`, so the runtime core runs with no Electron
 * in node_modules.
 *
 * userData fidelity is the critical contract: paired devices, the E2EE keypair,
 * terminal history, and daemon checkpoints all live under userData. An operator
 * SHOULD set ORCA_USER_DATA_PATH explicitly (especially for ephemeral VMs where
 * a persistent volume is mounted there). When unset we fall back to the
 * per-platform location Electron would have used for an app named 'Orca'.
 */
export type NodeAppEnvironmentOptions = {
  /** Overrides ORCA_USER_DATA_PATH; the persistent data dir. */
  userDataPath?: string
  /** The install/bundle root (defaults to the dir holding this entry). */
  appPath?: string
  version?: string
  packaged?: boolean
}

export class NodeAppEnvironment implements AppEnvironment {
  private readonly userDataPath: string
  private readonly appPath: string
  private readonly version: string
  private readonly packaged: boolean
  private readonly willQuitHandlers: (() => void)[] = []
  private signalsInstalled = false

  constructor(options: NodeAppEnvironmentOptions = {}) {
    this.userDataPath =
      options.userDataPath ?? process.env.ORCA_USER_DATA_PATH ?? defaultUserDataPath()
    this.appPath = options.appPath ?? defaultAppPath()
    this.version =
      options.version ?? process.env.ORCA_APP_VERSION ?? readBundledVersion(this.appPath) ?? '0.0.0'
    // Treat a node-server deployment as "packaged" by default: it ships built
    // assets, not a dev tree. Override via ORCA_IS_PACKAGED=0 for local runs.
    this.packaged = options.packaged ?? process.env.ORCA_IS_PACKAGED !== '0'
  }

  getPath(name: AppPathName): string {
    switch (name) {
      case 'userData':
        return this.userDataPath
      case 'home':
        return homedir()
      case 'appData':
        return dirname(this.userDataPath)
      case 'temp':
        return tmpdir()
      case 'downloads':
        return join(homedir(), 'Downloads')
      case 'logs':
        return join(this.userDataPath, 'logs')
      case 'exe':
        return process.execPath
    }
  }

  getAppPath(): string {
    return this.appPath
  }

  getVersion(): string {
    return this.version
  }

  isPackaged(): boolean {
    return this.packaged
  }

  onWillQuit(handler: () => void): void {
    this.willQuitHandlers.push(handler)
    this.installSignalHandlersOnce()
  }

  quit(): void {
    this.runWillQuit()
    process.exit(0)
  }

  exit(code = 0): void {
    process.exit(code)
  }

  relaunch(): void {
    // A node server cannot relaunch itself; exit non-zero so a supervisor (or
    // container restart policy) brings it back.
    this.runWillQuit()
    process.exit(1)
  }

  getAppMetrics(): AppProcessMetric[] {
    // Electron-only Chromium per-process metrics; no Node equivalent.
    return []
  }

  private installSignalHandlersOnce(): void {
    if (this.signalsInstalled) {
      return
    }
    this.signalsInstalled = true
    const onSignal = (): void => {
      this.runWillQuit()
      process.exit(0)
    }
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
  }

  private runWillQuit(): void {
    for (const handler of this.willQuitHandlers.splice(0)) {
      try {
        handler()
      } catch {
        // Best-effort shutdown; a failing hook must not block exit.
      }
    }
  }
}

// Why: mirror electron's userData location for an app named 'Orca' so an
// operator who does NOT set ORCA_USER_DATA_PATH still lands on the conventional
// per-platform path rather than a surprise directory.
function defaultUserDataPath(): string {
  const home = homedir()
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Orca')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Orca')
  }
  // Linux / other: XDG_CONFIG_HOME or ~/.config
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Orca')
}

function defaultAppPath(): string {
  return dirname(realpathSync(process.argv[1] ?? process.execPath))
}

function readBundledVersion(appPath: string): string | null {
  try {
    const pkgPath = join(appPath, 'package.json')
    if (!existsSync(pkgPath)) {
      return null
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}
