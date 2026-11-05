import { OrcaRuntimeWithApplyLayout } from './terminal-layout-application'

export abstract class OrcaRuntimeWithHandleMobileSubscribe extends OrcaRuntimeWithApplyLayout {
  protected abstract handleMobileSubscribeInternal(
    ptyId: string,
    clientId: string,
    viewport?: { cols: number; rows: number }
  ): Promise<boolean>

  // Runtime owns mobile fitting; retain separate client records per PTY. Desktop-mode subscriptions only watch and must not claim the floor.
  async handleMobileSubscribe(
    ptyId: string,
    clientId: string,
    viewport?: { cols: number; rows: number }
  ): Promise<boolean> {
    try {
      return await this.handleMobileSubscribeInternal(ptyId, clientId, viewport)
    } finally {
      // Every subscribe path mutates mobileSubscribers — resync the daemon
      // background mark once, whatever branch returned.
      this.notifyRemoteTerminalViewPresenceChanged(ptyId)
    }
  }
}
