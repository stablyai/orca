import { LocalPtyProvider } from '../../providers/local-pty-provider'
import { localProvider } from './provider/registry'

/**
 * Kill in-process local PTYs. Daemon-backed PTYs are preserved by daemon disconnect.
 */
export function killAllPty(): Promise<void> {
  if (localProvider instanceof LocalPtyProvider) {
    return localProvider.killAll()
  }
  return Promise.resolve()
}
