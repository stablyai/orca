import { getAppEnvironment } from '../../shared/app-environment'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../shared/execution-host'
import {
  createManagedCliContext,
  ManagedCliLauncherUnavailableError,
  type ManagedCliContext
} from '../../shared/managed-cli-context'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../shared/workspace-scope'
import type { WorkspaceKey } from '../../shared/folder-workspace-types'
import { getManagedCliLauncherStatus } from '../ssh/ssh-relay-session'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import { resolveLocalProjectRuntimeForWorktreeId } from '../local-project-runtime-resolution'
import { OrcaRuntimeWithGetOrchestrationDispatchAuthority } from './orca-runtime-get-orchestration-dispatch-authority'
import { resolveManagedOrchestrationExecutable } from './orchestration/cli-command'

function runtimeIsPackaged(): boolean {
  return getAppEnvironment().isPackaged()
}

export class OrcaRuntimeWithManagedCliContext extends OrcaRuntimeWithGetOrchestrationDispatchAuthority {
  resolveProjectRuntimeForWorktree(
    worktreeId: string | null | undefined
  ): ProjectExecutionRuntimeResolution | undefined {
    return this.store && worktreeId
      ? resolveLocalProjectRuntimeForWorktreeId(this.store, worktreeId)
      : undefined
  }

  private requireInstalledManagedCliLauncherPath(connectionId: string): string {
    const status = getManagedCliLauncherStatus(connectionId)
    if (!status || status.state === 'unavailable') {
      throw new ManagedCliLauncherUnavailableError(
        connectionId,
        status?.state === 'unavailable' ? status.reason : 'launcher status not yet established'
      )
    }
    return status.launcherPath
  }

  assertTerminalManagedCliAvailable(handle: string): void {
    const context = this.resolveTerminalContext(handle)
    if (context?.connectionId) {
      this.requireInstalledManagedCliLauncherPath(context.connectionId)
    }
  }

  preflightWorktreeManagedCliExecutable(worktree: { id: string; hostId?: string }): string {
    const parsedHost = worktree.hostId ? parseExecutionHostId(worktree.hostId) : null
    const connectionId = parsedHost?.kind === 'ssh' ? parsedHost.targetId : null
    return resolveManagedOrchestrationExecutable({
      connectionId,
      isWsl: undefined,
      worktreeId: worktree.id,
      projectRuntime: this.resolveProjectRuntimeForWorktree(worktree.id),
      isPackaged: runtimeIsPackaged(),
      launcherPath: connectionId ? this.requireInstalledManagedCliLauncherPath(connectionId) : null
    })
  }

  assertWorktreeManagedCliAvailable(worktree: { id: string; hostId?: string }): void {
    this.preflightWorktreeManagedCliExecutable(worktree)
  }

  private workspaceKeyForManagedCli(worktreeId: string): WorkspaceKey {
    const parsed = parseWorkspaceKey(worktreeId)
    return parsed?.type === 'folder'
      ? folderWorkspaceKey(parsed.folderWorkspaceId)
      : worktreeWorkspaceKey(worktreeId)
  }

  private buildManagedCliContextCore(args: {
    connectionId: string | null
    worktreeId: string | null
    isWsl?: boolean | null
    terminalHandle: string
  }): ManagedCliContext {
    const executable = resolveManagedOrchestrationExecutable({
      connectionId: args.connectionId,
      isWsl: args.isWsl,
      worktreeId: args.worktreeId ?? '',
      projectRuntime: args.worktreeId
        ? this.resolveProjectRuntimeForWorktree(args.worktreeId)
        : undefined,
      isPackaged: runtimeIsPackaged(),
      launcherPath: args.connectionId
        ? this.requireInstalledManagedCliLauncherPath(args.connectionId)
        : null
    })
    return createManagedCliContext({
      executable,
      runtimeId: this.getRuntimeId(),
      executionHostId: args.connectionId
        ? toSshExecutionHostId(args.connectionId)
        : LOCAL_EXECUTION_HOST_ID,
      workspaceKey: args.worktreeId
        ? this.workspaceKeyForManagedCli(args.worktreeId)
        : `terminal:${args.terminalHandle}`,
      terminalHandle: args.terminalHandle
    })
  }

  protected buildManagedCliContextForSpawn(args: {
    connectionId: string | null
    worktreeId: string
    isWsl?: boolean | null
    terminalHandle: string
  }): ManagedCliContext {
    if (!args.worktreeId || args.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
      throw new Error(`managed_cli_context_workspace_unresolved: ${args.terminalHandle}`)
    }
    return this.buildManagedCliContextCore(args)
  }

  buildTerminalManagedCliContext(handle: string): ManagedCliContext {
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    const pty = ptyId ? this.ptysById.get(ptyId) : null
    if (!pty?.worktreeId) {
      throw new Error(`managed_cli_context_terminal_not_found: ${handle}`)
    }
    return this.buildManagedCliContextCore({
      connectionId: pty.connectionId ?? null,
      worktreeId: pty.worktreeId,
      isWsl: pty.isWsl,
      terminalHandle: handle
    })
  }

  proveManagedTerminalIdentity(params: {
    terminalHandle: string
    executionHostId: string
    workspaceKey: string
    paneKey: string
    ptyIncarnation: string
  }): boolean {
    try {
      const context = this.buildTerminalManagedCliContext(params.terminalHandle)
      const terminalIdentity = this as typeof this & {
        getTerminalPaneKey(handle: string): string | null
        getTerminalProcessIncarnation(handle: string): string | null
      }
      return (
        context.executionHostId === params.executionHostId &&
        context.workspaceKey === params.workspaceKey &&
        terminalIdentity.getTerminalPaneKey(params.terminalHandle) === params.paneKey &&
        terminalIdentity.getTerminalProcessIncarnation(params.terminalHandle) ===
          params.ptyIncarnation
      )
    } catch {
      return false
    }
  }
}
