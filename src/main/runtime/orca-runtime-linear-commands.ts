// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithFileCommands } from './orca-runtime-file-commands'
import { RuntimeLinearCommands } from './runtime-linear-connection-commands'

export class OrcaRuntimeWithLinearCommands extends OrcaRuntimeWithFileCommands {
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
