import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import type { RuntimeTerminalShow } from '../../../../shared/runtime-terminal-contracts'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'

import { RuntimeLinearBrowseCommands } from './runtime-linear-browse-commands'

export type RuntimeLinearCommandPorts = {
  runtimeAvailable: () => boolean
  showTerminal: (handle: string) => Promise<RuntimeTerminalShow>
  resolveWorkspaceSelector: (selector: string) => Promise<ResolvedWorktree>
  listResolvedWorktrees: () => Promise<ResolvedWorktree[]>
  setWorktreeMeta: (
    worktree: Pick<ResolvedWorktree, 'id' | 'hostId'>,
    meta: {
      linkedLinearIssueWorkspaceId: string
      linkedLinearIssueOrganizationUrlKey: string | null
    }
  ) => void
  emitClientEvent: (event: LinearLinkedIssueUpdatedEvent) => void
}

// Root browse reads so write commands can reenter through this, preserving facade dispatch.
export class RuntimeLinearCommandBase extends RuntimeLinearBrowseCommands {
  constructor(private readonly ports: RuntimeLinearCommandPorts) {
    super()
  }

  protected runtimeAvailable(): boolean {
    return this.ports.runtimeAvailable()
  }

  protected showTerminal(handle: string): Promise<RuntimeTerminalShow> {
    return this.ports.showTerminal(handle)
  }

  protected resolveWorkspaceSelector(selector: string): Promise<ResolvedWorktree> {
    return this.ports.resolveWorkspaceSelector(selector)
  }

  protected listResolvedWorktrees(): Promise<ResolvedWorktree[]> {
    return this.ports.listResolvedWorktrees()
  }

  protected setWorktreeMeta(
    worktree: Pick<ResolvedWorktree, 'id' | 'hostId'>,
    meta: {
      linkedLinearIssueWorkspaceId: string
      linkedLinearIssueOrganizationUrlKey: string | null
    }
  ): void {
    this.ports.setWorktreeMeta(worktree, meta)
  }

  protected emitClientEvent(event: LinearLinkedIssueUpdatedEvent): void {
    this.ports.emitClientEvent(event)
  }
}

export type LinearLinkedIssueUpdatedEvent = Extract<
  RuntimeClientEvent,
  { type: 'linearLinkedIssueUpdated' }
>
