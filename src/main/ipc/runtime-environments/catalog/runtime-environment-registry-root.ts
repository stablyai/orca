import { app } from 'electron'
import { resolveEnvironment } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'

/** Where the paired-runtime registry lives; read per call, after `app.setName` settles the casing. */
export function getRuntimeEnvironmentRegistryRoot(): string {
  return app.getPath('userData')
}

/** The pairing a call to this environment should pin; throws for an environment no longer paired. */
export async function readRegisteredPairingRevision(environmentId: string): Promise<number> {
  const environment = await resolveEnvironment(getRuntimeEnvironmentRegistryRoot(), environmentId)
  return environment.pairingRevision ?? environment.createdAt
}
