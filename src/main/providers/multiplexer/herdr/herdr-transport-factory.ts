import type { HerdrHostTransport } from './herdr-runtime-contract'
import { HerdrCliHostTransport, localHerdrCommand } from './herdr-cli-host-transport'
import { HerdrSshHostTransport } from './herdr-ssh-host-transport'
import { HerdrSocketTransport } from './herdr-socket-transport'
import type { SshConnection } from '../../../ssh/ssh-connection'
import type { RemoteHostPlatform } from '../../../ssh/ssh-remote-platform'

export type TransportType = 'auto' | 'socket' | 'cli' | 'ssh'

export type HerdrTransportFactoryOptions = {
  type: TransportType
  socketPath?: string
  timeoutMs?: number
  cliCommand?: string
  sshConnection?: SshConnection
  remoteHostPlatform?: RemoteHostPlatform
}

export const DEFAULT_HERDR_SESSION_NAME = 'orca'

export class HerdrTransportFactory {
  private readonly options: HerdrTransportFactoryOptions

  constructor(options: HerdrTransportFactoryOptions) {
    this.options = options
  }

  private resolvedType(): 'socket' | 'cli' | 'ssh' {
    if (this.options.type === 'auto') {
      return 'socket'
    }
    return this.options.type
  }

  createSocketTransport(sessionName: string): HerdrSocketTransport {
    return new HerdrSocketTransport({
      sessionName,
      timeoutMs: this.options.timeoutMs ?? 15000,
      socketPath: this.options.socketPath
    })
  }

  createCliTransport(): HerdrCliHostTransport {
    const binary = this.options.cliCommand ?? 'herdr'
    return new HerdrCliHostTransport({
      commandFor: localHerdrCommand(binary),
      timeoutMs: this.options.timeoutMs ?? 15000
    })
  }

  createSshTransport(): HerdrSshHostTransport {
    if (!this.options.sshConnection) {
      throw new Error('SSH connection required for SSH transport')
    }

    return new HerdrSshHostTransport(
      this.options.sshConnection,
      this.options.timeoutMs ?? 15000,
      async () => this.options.cliCommand ?? 'herdr',
      this.options.remoteHostPlatform
    )
  }

  createTransport(): HerdrHostTransport {
    switch (this.resolvedType()) {
      case 'socket':
        return this.createSocketTransport(DEFAULT_HERDR_SESSION_NAME)
      case 'ssh':
        return this.createSshTransport()
      case 'cli':
        return this.createCliTransport()
    }
  }

  static getDefaultOptions(): HerdrTransportFactoryOptions {
    return {
      type: 'auto',
      timeoutMs: 15000
    }
  }
}
