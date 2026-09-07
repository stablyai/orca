import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'

export class TerminalHostAgentSessionGenerations {
  private readonly byPtyId = new Map<string, string>()

  isCurrent(owner: AgentSessionOwnerBinding, isPtyLive: boolean): boolean {
    return isPtyLive && this.byPtyId.get(owner.ptyId) === owner.generation
  }

  remember(ptyId: string, generation: string | undefined, isPtyLive: boolean): void {
    if (generation && isPtyLive) {
      this.byPtyId.set(ptyId, generation)
    }
  }

  forget(ptyId: string, generation?: string): void {
    if (generation === undefined || this.byPtyId.get(ptyId) === generation) {
      this.byPtyId.delete(ptyId)
    }
  }
}
