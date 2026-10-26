import { getAppEnvironment } from '../../shared/app-environment'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ConnectorCloud, type ConnectorHostRuntime } from './connector-cloud'
import { resolveConnectorOrigin } from './connector-origin'

/** Electron-free, so desktop, Electron serve and orcad install the same link. */
export function installConnectorCloud(
  runtime: OrcaRuntimeService,
  userDataPath: string,
  hostRuntime: ConnectorHostRuntime
): void {
  const environment = getAppEnvironment()
  runtime.setConnectorCloud(
    new ConnectorCloud({
      userDataPath,
      origin: resolveConnectorOrigin(process.env, environment.isPackaged()),
      runtime: hostRuntime,
      orcaVersion: environment.getVersion(),
      // The seam exists exactly while experimentalConnectors is on.
      connectorsEnabled: () => runtime.getExternalConversationSeam() !== null
    })
  )
}
