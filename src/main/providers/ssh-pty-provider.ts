import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { RemoteCliBridgeEnv } from './ssh-pty-provider-contract'
import { RelayPtyProvider } from './relay-pty-provider'
import { sshRelayPtyIdMapping } from './relay-pty-id-mapping'

/** SSH owns connection identity; the relay provider owns transport and terminal semantics. */
export class SshPtyProvider extends RelayPtyProvider {
  constructor(
    private readonly connectionId: string,
    mux: SshChannelMultiplexer,
    remoteCliBridgeEnv?: RemoteCliBridgeEnv,
    providerGeneration = 1
  ) {
    super(sshRelayPtyIdMapping(connectionId), mux, remoteCliBridgeEnv, providerGeneration)
  }

  getConnectionId = (): string => this.connectionId
}
