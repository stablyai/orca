import type { RuntimeTerminalShow } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import { OrcaRuntimeWithRepositoryCommands } from '../../construction/runtime-repository-command-state'
import { RuntimeLinearCommands } from './runtime-linear-connection-commands'
import {
  readWorktreeMetaForHost,
  worktreeRowTarget
} from '../../../persistence/host-qualified-worktree-meta'

export abstract class OrcaRuntimeWithLinearCommands extends OrcaRuntimeWithRepositoryCommands {
  abstract showTerminal(handle: string): Promise<RuntimeTerminalShow>

  protected abstract listResolvedWorktrees(): Promise<ResolvedWorktree[]>

  readonly linearCommands = new RuntimeLinearCommands({
    runtimeAvailable: () => this.store !== null,
    showTerminal: (handle) => this.showTerminal(handle),
    resolveWorkspaceSelector: (selector) => this.resolveWorkspaceSelector(selector),
    listResolvedWorktrees: () => this.listResolvedWorktrees(),
    setWorktreeMeta: (worktree, meta) => {
      const target = worktreeRowTarget(this.store!, worktree)
      if (
        target &&
        readWorktreeMetaForHost(this.store!, target.id, target.hostId)?.linkedLinearIssue ===
          worktree.linkedLinearIssue
      ) {
        this.store!.setWorktreeMeta(target, meta)
      }
    },
    emitClientEvent: (event) => this.emitClientEvent(event)
  })
}
