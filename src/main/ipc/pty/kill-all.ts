import { LocalPtyProvider } from '../../providers/local-pty-provider'
import { localProvider } from './provider/registry'

/** Kill in-process PTYs while daemon-backed sessions survive disconnect. */
export function killAllPty(): void {
  if (localProvider instanceof LocalPtyProvider) {
    localProvider.killAll()
  }
}
