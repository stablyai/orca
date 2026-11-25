import { LocalPtyProvider } from '../../../providers/local-pty/local-pty-provider'
import {
  pendingLocalPtySpawns,
  ptyProcesses
} from '../../../providers/local-pty/local-pty-provider-state'
import { localProvider } from './registry'

export function hasInProcessTerminalSessions(): boolean {
  return ptyProcesses.size > 0 || pendingLocalPtySpawns.size > 0
}

/** Kill in-process PTYs while daemon-backed sessions survive disconnect. */
export function killAllPty(): void {
  if (localProvider instanceof LocalPtyProvider) {
    localProvider.killAll()
  }
}
