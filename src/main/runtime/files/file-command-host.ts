import type { RuntimeStore } from '../runtime-store-contract'
import type { ResolvedRuntimeFileTarget, ResolvedRuntimeFileWorktree } from './file-target'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeNativeChatFileContext } from '../../../shared/runtime-types'
import type { RuntimeNavigationTarget } from '../../../shared/runtime-navigation'
import type { RuntimeFileOpenPosition } from '../../../shared/runtime-file-contracts'

export type RuntimeFileCommandHost = {
  getRuntimeId(): string
  requireStore(): RuntimeStore
  resolveWorktreeSelector(selector: string): Promise<ResolvedRuntimeFileWorktree>
  resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget>
  resolveKnownWorkspaceFileTarget?(
    absolutePath: string,
    executionHostId: ExecutionHostId
  ): Promise<(ResolvedRuntimeFileTarget & { relativePath: string }) | null>
  resolveTerminalCwd?(terminalHandle: string): string | null | Promise<string | null>
  resolveTerminalContext?(
    terminalHandle: string
  ): { worktreeId: string; connectionId: string | null } | null
  resolveTerminalFileUriHostname?(terminalHandle: string): string | null | Promise<string | null>
  hasRecentTerminalOutputPath?(
    terminalHandle: string,
    pathText: string,
    absolutePath: string
  ): boolean | Promise<boolean>
  hasRecentNativeChatOutputPath?(
    worktreeId: string,
    context: RuntimeNativeChatFileContext,
    pathText: string,
    absolutePath: string
  ): boolean | Promise<boolean>
  // `executionHostId`, not `connectionId`, on both target contracts: a repo row's connection cannot
  // tell `runtime:` from `local`, and neither may re-introduce that spelling. See
  // runtime-git-command-target and runtime-file-command-target.
  resolveRuntimeGitTarget(
    selector: string
  ): Promise<{ worktree: ResolvedRuntimeFileWorktree; executionHostId: ExecutionHostId }>
  openFile(
    worktreeId: string,
    filePath: string,
    relativePath: string,
    runtimeEnvironmentId?: string | null,
    navigation?: RuntimeNavigationTarget,
    position?: RuntimeFileOpenPosition
  ): void
  openDiff(
    worktreeId: string,
    filePath: string,
    relativePath: string,
    staged: boolean,
    runtimeEnvironmentId?: string | null,
    navigation?: RuntimeNavigationTarget
  ): void
}
