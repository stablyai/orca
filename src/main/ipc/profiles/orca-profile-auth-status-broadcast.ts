import { refreshCommanderRecovery } from '../../commander/commander-recovery-service'
import { BrowserWindow } from 'electron'
import {
  ORCA_PROFILE_AUTH_STATUS_CHANGED_CHANNEL,
  ORCA_PROFILE_SIGN_IN_PROGRESS_CHANGED_CHANNEL,
  type OrcaCloudSignInProgress
} from '../../../shared/orca-profiles/orca-profiles'
import {
  getActiveTeamCapabilities,
  onTeamCapabilitiesInvalidated
} from '../../orca-profiles/cloud-auth/active-team-capabilities'

function broadcast(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(channel, ...args)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}

export function broadcastOrcaProfileAuthStatusChanged(): void {
  refreshCommanderRecovery()
  broadcast(ORCA_PROFILE_AUTH_STATUS_CHANGED_CHANNEL)
}

export function broadcastTeamPolicyChanges(): void {
  const snapshot = (): string | undefined => {
    const team = getActiveTeamCapabilities()
    return team && JSON.stringify([team.teamPolicy, team.flags])
  }
  let previous = snapshot()
  onTeamCapabilitiesInvalidated(() => {
    const next = snapshot()
    if (next !== previous) {
      previous = next
      broadcastOrcaProfileAuthStatusChanged()
    }
  })
}

export function broadcastOrcaProfileSignInProgressChanged(
  progress: OrcaCloudSignInProgress | null
): void {
  broadcast(ORCA_PROFILE_SIGN_IN_PROGRESS_CHANGED_CHANNEL, progress)
}
