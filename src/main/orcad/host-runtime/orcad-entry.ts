import process from 'node:process'
import { startBackendCore } from '../../backend/core-runtime'
import { resolveUserDataPath } from './orcad-app-paths'
import { prepareOrcadCliLauncher } from '../serve-startup/orcad-cli-launcher'
import { installOrcadHostAdapters, runOrcadQuitHandlers } from './orcad-host-adapters'
import { prepareOrcadSecretStoreAndMigrate } from '../credentials/orcad-secret-store-startup'
import type { OrcadHandle, OrcadOptions } from '../serve-startup/orcad-start-contract'
import { stampRuntimeSourceEnv } from '../../../shared/remote-runtime/host-catalog/runtime-source-env'
import { ORCA_SERVE_SUPERVISED_ENV } from '../../../shared/remote-runtime/serve-supervisor/serve-supervised-terminal-durability'

/** Resolve after transport readiness publishes the desktop-compatible serve payload. */
export async function startOrcad(options: OrcadOptions = {}): Promise<OrcadHandle> {
  installOrcadHostAdapters()
  // Inherited terminal identity must not fence orcad’s CLI children to the launching desktop.
  stampRuntimeSourceEnv(process.env, null)
  const userDataPath = resolveUserDataPath()
  // Override inherited data roots so CLI-shared Codex homes resolve on this host.
  process.env.ORCA_USER_DATA_PATH = userDataPath
  return startBackendCore({
    userDataPath,
    supervised: process.env[ORCA_SERVE_SUPERVISED_ENV] === '1',
    options,
    prepareCliLauncher: prepareOrcadCliLauncher,
    prepareSecrets: prepareOrcadSecretStoreAndMigrate,
    runQuitHandlers: runOrcadQuitHandlers
  })
}
