import type { RuntimeTerminalShow } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import { OrcaRuntimeWithRepositoryCommands } from '../../construction/runtime-repository-command-state'
import type { RuntimeLinearCommands } from './runtime-linear-connection-commands'
import {
  readWorktreeMetaForHost,
  worktreeRowTarget
} from '../../../persistence/host-qualified-worktree-meta'

export abstract class OrcaRuntimeWithLinearCommands extends OrcaRuntimeWithRepositoryCommands {
  abstract showTerminal(handle: string): Promise<RuntimeTerminalShow>

  protected abstract listResolvedWorktrees(): Promise<ResolvedWorktree[]>

  private linearCommandsInstance: RuntimeLinearCommands | null = null
  private linearCommandsPromise: Promise<RuntimeLinearCommands> | null = null

  loadLinearCommands(): Promise<RuntimeLinearCommands> {
    if (this.linearCommandsInstance) {
      return Promise.resolve(this.linearCommandsInstance)
    }
    if (!this.linearCommandsPromise) {
      this.linearCommandsPromise = import('./runtime-linear-connection-commands')
        .then(({ RuntimeLinearCommands }) => {
          this.linearCommandsInstance = new RuntimeLinearCommands({
            runtimeAvailable: () => this.store !== null,
            showTerminal: (handle) => this.showTerminal(handle),
            resolveWorkspaceSelector: (selector) => this.resolveWorkspaceSelector(selector),
            listResolvedWorktrees: () => this.listResolvedWorktrees(),
            setWorktreeMeta: (worktree, meta) => {
              const target = worktreeRowTarget(this.store!, worktree)
              const current =
                target && readWorktreeMetaForHost(this.store!, target.id, target.hostId)
              // A relink (issue, workspace or organization) that landed during the async lookup wins.
              if (
                target &&
                current &&
                current.linkedLinearIssue === worktree.linkedLinearIssue &&
                (current.linkedLinearIssueWorkspaceId ?? null) ===
                  (worktree.linkedLinearIssueWorkspaceId ?? null) &&
                (current.linkedLinearIssueOrganizationUrlKey ?? null) ===
                  (worktree.linkedLinearIssueOrganizationUrlKey ?? null)
              ) {
                this.store!.setWorktreeMeta(target, meta)
              }
            },
            emitClientEvent: (event) => this.emitClientEvent(event)
          })
          return this.linearCommandsInstance
        })
        .catch((error: unknown) => {
          this.linearCommandsPromise = null
          throw error
        })
    }
    return this.linearCommandsPromise
  }
}
