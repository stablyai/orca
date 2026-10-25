// A saved tunnel port can become unbindable: a Windows excluded port range or another app's listener.
import { moveManagedOrcadLocalPort } from '../../../shared/runtime-environment-managed-orcad-store'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import { getOrcadSshDeployment } from '../../../shared/runtime-environments'
import { reserveLocalForwardPort } from '../../ssh/system-transport/system-ssh-forward-port-reservation'
import { notifyManagedOrcadPairingRepaired } from './orcad-managed-pairing-repaired-listener'

// Reservation reports the bind error code as `cause`; Windows excluded ranges answer EACCES.
const UNBINDABLE_LOCAL_PORT_CODES = new Set<unknown>(['EADDRINUSE', 'EACCES'])

/**
 * Builds once more on a free local port when the saved one cannot be bound. The port is local to
 * this desktop, so the move keeps the pairing, the server's identity and its projects.
 */
export async function buildOnBindableLocalPort<T>(
  userDataPath: string,
  environmentId: string,
  build: () => Promise<T>
): Promise<T> {
  const savedPort = () =>
    getOrcadSshDeployment(resolveEnvironment(userDataPath, environmentId))?.localPort
  const saved = savedPort()
  try {
    return await build()
  } catch (error) {
    if (saved === undefined) {
      throw error
    }
    // A concurrent build moved this server, superseding or failing ours; build on what it saved.
    if (savedPort() !== saved) {
      return build()
    }
    if (!(error instanceof Error) || !UNBINDABLE_LOCAL_PORT_CODES.has(error.cause)) {
      throw error
    }
    const localPort = await reserveLocalForwardPort(0)
    if (savedPort() !== saved) {
      return build()
    }
    console.warn(
      `[ssh] Moving the tunnel to this host’s Orca server from local port ${saved} to ${localPort}: ${error.message}`
    )
    moveManagedOrcadLocalPort(userDataPath, environmentId, localPort)
    // Like a repair, the rebind retires transports and status owners still dialing the old port.
    await notifyManagedOrcadPairingRepaired(environmentId)
    return build()
  }
}
