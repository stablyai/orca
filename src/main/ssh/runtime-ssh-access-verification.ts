import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { verifyRuntimeEnvironmentIdentity } from '../runtime/runtime-environment-identity-verification'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import type { RuntimeStatus } from '../../shared/runtime-types'

export async function verifyRuntimeEnvironmentSshTunnel(
  environment: KnownRuntimeEnvironment,
  localPort: number,
  signal?: AbortSignal
): Promise<{
  verifiedConnection: PairedRuntimeConnection
  verifiedRuntimeId: string
  runtimeStatus: RuntimeStatus
}> {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
    throw new Error('The SSH tunnel did not provide a valid local port.')
  }
  // The tunnel targets the native listener, not the public reverse proxy; E2EE still pins its key.
  return verifyRuntimeEnvironmentIdentity(environment, {
    endpoint: `ws://127.0.0.1:${localPort}`,
    signal
  })
}
