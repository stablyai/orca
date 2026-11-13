import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { ORCAD_CLI_PACKAGE_FILENAME } from '../../../shared/orcad-artifacts'
import { setAppEnvironment, type AppEnvironment } from '../../../shared/app-environment'
import { createNodeServiceEnvironment } from '../../backend/node-service-environment'
import { setSecretStore } from '../../../shared/secret-store'
import { resolveOrcadInstallRoot, resolveOrcadPath } from './orcad-app-paths'
import { getOrcadCliLauncherPath } from '../serve-startup/orcad-cli-launcher'
import { createOrcadSecretStore, type OrcadSecretStore } from '../credentials/orcad-secret-store'
import { setSpeechServiceFactories } from '../../speech/speech-runtime-service'
import { orcadSpeechServiceFactories } from './orcad-speech-services'

let quitRegisteredHandlers = (): void => {}

export function runOrcadQuitHandlers(): void {
  quitRegisteredHandlers()
}

function createNodeAppEnvironment(): AppEnvironment {
  const host = createNodeServiceEnvironment({
    getPath: resolveOrcadPath,
    getAppPath: () => resolveOrcadInstallRoot(),
    getVersion: () => process.env.ORCA_VERSION ?? '0.0.0-orcad',
    isPackaged: () => true,
    getCliLauncherPath: getOrcadCliLauncherPath
  })
  quitRegisteredHandlers = host.runQuitHandlers
  return host.environment
}

let orcadSecretStore: OrcadSecretStore | null = null

export async function prepareOrcadSecretStore(
  keyDir: string,
  userDataPath: string
): Promise<boolean> {
  if (!orcadSecretStore) {
    throw new Error('orcad_secret_store_not_installed — call installOrcadHostAdapters() first')
  }
  return orcadSecretStore.prepare({ keyDir, userDataPath })
}

/** Stamp the bundle’s own release so inherited desktop versions cannot misidentify this server. */
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
  setSpeechServiceFactories(orcadSpeechServiceFactories)
}
