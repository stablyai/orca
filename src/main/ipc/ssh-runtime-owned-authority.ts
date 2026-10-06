import type { BrowserWindow } from 'electron'
import { isRuntimeOwnedSshTargetId } from '../../shared/execution-host'
import type { RuntimeOwnedSshAuthority } from '../../shared/runtime-owned-ssh-authority'
import type { SshConnectionState } from '../../shared/ssh-types'
import { getSshConnectionGeneration } from '../ssh/ssh-connection-generation'
import { activeSessions } from './ssh-active-relay-sessions'
import { connectInFlight } from './ssh-connect-attempt-registry'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { targetLifecycleInFlight } from './ssh-target-lifecycle-queue'

export function publishRuntimeOwnedSshAuthority(
  getMainWindow: () => BrowserWindow | null,
  targetId: string,
  connectionGeneration: number | null
): void {
  if (!isRuntimeOwnedSshTargetId(targetId)) {
    return
  }
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('ssh:runtime-owned-authority-changed', {
      targetId,
      connectionGeneration
    } satisfies RuntimeOwnedSshAuthority)
  }
}

export function getRuntimeOwnedSshAuthority(
  targetId: string,
  state: SshConnectionState | null | undefined
): RuntimeOwnedSshAuthority {
  return {
    targetId,
    connectionGeneration:
      !targetLifecycleInFlight.has(targetId) &&
      !connectInFlight.has(targetId) &&
      state?.status === 'connected' &&
      activeSessions.get(targetId)?.getState() === 'ready'
        ? getSshConnectionGeneration(targetId)
        : null
  }
}

export function revokeRuntimeOwnedSshAuthority(targetId: string): void {
  publishRuntimeOwnedSshAuthority(getCurrentMainWindow, targetId, null)
}

export function listRuntimeOwnedSshAuthorities(
  getState: (targetId: string) => SshConnectionState | null | undefined
): RuntimeOwnedSshAuthority[] {
  return [...activeSessions.keys()]
    .filter(isRuntimeOwnedSshTargetId)
    .map((targetId) => getRuntimeOwnedSshAuthority(targetId, getState(targetId)))
    .filter((authority) => authority.connectionGeneration !== null)
}
