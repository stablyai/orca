import type { RuntimeTerminalShow } from '../../../../shared/runtime-terminal-contracts'
import type { ResolvedWorktree } from '../../runtime-worktree-path-identity'
import { OrcaRuntimeWithFileCommands } from '../../construction/runtime-file-command-state'
import { RuntimeLinearCommands } from '../../runtime-linear-connection-commands'

export abstract class OrcaRuntimeWithLinearCommands extends OrcaRuntimeWithFileCommands {
  abstract showTerminal(handle: string): Promise<RuntimeTerminalShow>

  protected abstract listResolvedWorktrees(): Promise<ResolvedWorktree[]>

  // ── Linear integration ──

  readonly linearCommands = new RuntimeLinearCommands({
    runtimeAvailable: () => this.store !== null,
    showTerminal: (handle) => this.showTerminal(handle),
    resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
    listResolvedWorktrees: () => this.listResolvedWorktrees(),
    setWorktreeMeta: (worktreeId, meta) => this.store!.setWorktreeMeta(worktreeId, meta),
    emitClientEvent: (event) => this.emitClientEvent(event)
  })
}
