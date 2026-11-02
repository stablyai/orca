/** The Node host's stand-ins for Electron's app environment and secret store. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { ORCAD_CLI_PACKAGE_FILENAME } from '../../shared/orcad-artifacts'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import { setSecretStore } from '../../shared/secret-store'
import { resolveOrcadInstallRoot, resolveOrcadPath } from './orcad-app-paths'
import { getOrcadCliLauncherPath } from './orcad-cli-launcher'
import { createOrcadSecretStore, type OrcadSecretStore } from './orcad-secret-store'

let quitRegisteredHandlers = (): void => {}

export function runOrcadQuitHandlers(): void {
  quitRegisteredHandlers()
}

function createNodeAppEnvironment(): AppEnvironment {
  const quitHandlers: (() => void)[] = []
  // The main signal handler awaits runtime and browser teardown before process.exit.
  // Keep will-quit callbacks synchronous, but never let them pre-empt that async barrier.
  quitRegisteredHandlers = (): void => {
    const errors: unknown[] = []
    for (const handler of quitHandlers.splice(0)) {
      try {
        handler()
      } catch (error) {
        errors.push(error)
      }
    }
    // Why throw: a quit handler that failed may leave a writer running, which keeps the lock.
    if (errors.length > 0) {
      throw new AggregateError(errors, 'orcad_quit_handlers_failed')
    }
  }
  return {
    getPath: resolveOrcadPath,
    getAppPath: () => resolveOrcadInstallRoot(),
    getVersion: () => process.env.ORCA_VERSION ?? '0.0.0-orcad',
    // Why still true: consumers read this as "production build, not a dev checkout" —
    // it gates HTTPS-only skill downloads, the real CLI command name, and shell-PATH
    // hydration. Answering false to satisfy a path resolver would relax a security
    // posture. Layout questions must ask whether the app root is an asar archive
    // instead (see parcel-watcher-entry-path.ts).
    isPackaged: () => true,
    getCliLauncherPath: getOrcadCliLauncherPath,
    onWillQuit: (handler) => quitHandlers.push(handler),
    exit: (code = 0) => process.exit(code),
    // Why []: there are no Chromium processes on this host to measure.
    getAppMetrics: () => []
  }
}

let orcadSecretStore: OrcadSecretStore | null = null

/** Loads the sealing key kept in `keyDir`; resolves whether sealing works. */
export async function prepareOrcadSecretStore(
  keyDir: string,
  userDataPath: string
): Promise<boolean> {
  if (!orcadSecretStore) {
    throw new Error('orcad_secret_store_not_installed — call installOrcadHostAdapters() first')
  }
  return orcadSecretStore.prepare({ keyDir, userDataPath })
}

/**
 * The Orca release this server was built from, stamped into the bundle's own `out/package.json`.
 * Why: `status.get` and the updater report ORCA_APP_VERSION, which only the desktop's preflight
 * sets, so a server read `0.0.0-dev`. The bundle wins over an inherited value from another build.
 */
export function stampOrcadAppVersion(installRoot: () => string = resolveOrcadInstallRoot): void {
  let version: unknown
  try {
    const path = join(installRoot(), ...ORCAD_CLI_PACKAGE_FILENAME.split('/'))
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    version = parsed && typeof parsed === 'object' && 'version' in parsed ? parsed.version : null
  } catch {
    return
  }
  if (typeof version === 'string' && version.length > 0) {
    process.env.ORCA_APP_VERSION = version
  }
}

export function installOrcadHostAdapters(): void {
  stampOrcadAppVersion()
  setAppEnvironment(createNodeAppEnvironment())
  orcadSecretStore = createOrcadSecretStore()
  setSecretStore(orcadSecretStore)
}
