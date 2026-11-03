import { OrcaRuntimeWithTerminalDrivers } from '../terminal/driver/terminal-driver-resources'
import {
  configureStoreGitHubParticipantDevices,
  getStoreGitHubParticipants,
  type GitHubParticipantDeviceLookup
} from '../github-participant-store'

export abstract class OrcaRuntimeWithGitHubParticipants extends OrcaRuntimeWithTerminalDrivers {
  private githubParticipantDevices: () => { deviceId: string; name: string }[] = () => []

  getGitHubParticipantRegistry() {
    return this.store ? getStoreGitHubParticipants(this.store) : undefined
  }

  configureGitHubParticipantDevices(
    lookup: GitHubParticipantDeviceLookup,
    list: () => { deviceId: string; name: string }[]
  ): void {
    if (this.store) {
      configureStoreGitHubParticipantDevices(this.store, lookup)
    }
    this.githubParticipantDevices = list
  }

  listGitHubParticipantDevices(): { deviceId: string; name: string }[] {
    return this.githubParticipantDevices()
  }

  notifyGitHubParticipantAccountsChanged(): void {
    this.emitClientEvent({ type: 'githubParticipantAccountsChanged' })
    this.notifyReposChanged()
  }
}
