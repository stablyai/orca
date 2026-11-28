import type { BotShareDevices } from '../bots/team-share/bot-share-access'
import type { BotInviteCloudCall } from '../bots/team-share/bot-invite-email'
import { OrcaRuntimeWithLinearCommands } from './integrations/linear/linear-commands'

/** What sharing an agent with teammates needs of the runtime: their devices, the host key their held
 *  messages are sealed to, and this host's Orca Cloud calls for invites. */
export abstract class OrcaRuntimeWithBotTeamShare extends OrcaRuntimeWithLinearCommands {
  /** The RPC server's teammate devices of shared bots, set as it is made; null without one. */
  botShareDevices: BotShareDevices | null = null

  private readonly shareHostKeyListeners = new Set<() => void>()

  /** The RPC server loaded its pairing identity: held messages now have a key to be sealed to, which
   *  the connector's hello publishes (hostKey). */
  onBotShareHostKeyReady(listener: () => void): () => void {
    this.shareHostKeyListeners.add(listener)
    return () => this.shareHostKeyListeners.delete(listener)
  }

  notifyBotShareHostKeyReady(): void {
    for (const listener of this.shareHostKeyListeners) {
      listener()
    }
  }

  /** This host's signed-in Orca Cloud calls, set where its connector installs (desktop, serve, orcad). */
  botCloudAuth: BotInviteCloudCall | null = null
}
