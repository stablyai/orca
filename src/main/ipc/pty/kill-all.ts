import { LocalPtyProvider } from '../../providers/local-pty-provider'
import { getInProcessPtyProvider, localProvider } from './provider/registry'

/**
 * Kill in-process local PTYs. Daemon-backed PTYs are preserved by daemon disconnect.
 */
export function killAllPty(): void {
  const inProcess = getInProcessPtyProvider()
  inProcess.killAll()
  if (localProvider !== inProcess && localProvider instanceof LocalPtyProvider) {
    localProvider.killAll()
  }
}
