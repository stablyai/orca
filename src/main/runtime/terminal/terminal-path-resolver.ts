import type {
  RuntimeNativeChatFileContext,
  RuntimeTerminalPathResolution
} from '../../../shared/runtime-types'
import { parseWslPath } from '../../wsl'
import { relativePathInsideRoot, resolveRuntimePath } from '../../../shared/cross-platform-path'
import { homedir } from 'node:os'
import { resolveTerminalAbsolutePath } from './terminal-file-path'
import { requireRuntimeFileProvider, runtimeFileRouteForTarget } from '../files/file-target'
import { isSafeMobileRelativePath } from '../files/mobile-file-kind'
import { isENOENT } from '../../ipc/filesystem/filesystem-path-containment'
import type { RuntimeFileCommandHost } from '../files/file-command-host'
import type { RuntimeTerminalArtifacts } from './artifacts/terminal-artifacts'

const SSH_OUTSIDE_WORKSPACE_UNSUPPORTED_MESSAGE =
  "Files outside an SSH workspace can't be opened from another device yet."

type RuntimeTerminalPathHost = Pick<
  RuntimeFileCommandHost,
  | 'requireStore'
  | 'resolveRuntimeFileTarget'
  | 'resolveKnownWorkspaceFileTarget'
  | 'resolveTerminalCwd'
  | 'resolveTerminalFileUriHostname'
>
type RuntimeTerminalArtifactAuthority = Pick<RuntimeTerminalArtifacts, 'resolveAbsoluteFileGrant'>

export class RuntimeTerminalPathResolver {
  constructor(
    private readonly host: RuntimeTerminalPathHost,
    private readonly artifacts: RuntimeTerminalArtifactAuthority
  ) {}

  // Resolves a mobile terminal tap to a worktree-relative path; relatives resolve against cwd, else the worktree root.
  async resolveTerminalPath(
    worktreeSelector: string,
    pathText: string,
    cwd?: string | null,
    clientId?: string,
    terminalHandle?: string | null,
    crossWorkspace?: boolean,
    // Why: still sent by clients; any caller may open any host path, so the citing chat no longer matters.
    _nativeChatContext?: RuntimeNativeChatFileContext | null
  ): Promise<RuntimeTerminalPathResolution> {
    // Why: an absent store fails as runtime_unavailable before target resolution.
    this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree } = target
    const route = runtimeFileRouteForTarget(target)
    const connectionId = route.kind === 'ssh' ? route.connectionId : undefined
    // Mobile may connect after OSC 7; use runtime's latest terminal cwd for taps.
    const normalizedTerminalHandle =
      terminalHandle && terminalHandle.trim().length > 0 ? terminalHandle.trim() : null
    const terminalCwd = normalizedTerminalHandle
      ? await this.host.resolveTerminalCwd?.(normalizedTerminalHandle)
      : null
    const terminalFileUriHostname = normalizedTerminalHandle
      ? await this.host.resolveTerminalFileUriHostname?.(normalizedTerminalHandle)
      : null
    const base = terminalCwd || (cwd && cwd.trim().length > 0 ? cwd : worktree.path)

    const empty: RuntimeTerminalPathResolution = {
      worktree: worktree.id,
      relativePath: null,
      absolutePath: null,
      exists: false,
      isDirectory: false
    }

    // Never expand SSH/WSL home-relative grants using this machine's home.
    const isTilde = pathText.startsWith('~/') || pathText.startsWith('~\\')
    if (isTilde && (connectionId || parseWslPath(worktree.path))) {
      return empty
    }
    const expanded = isTilde ? resolveRuntimePath(homedir(), pathText.slice(2)) : pathText
    const absolutePath = resolveTerminalAbsolutePath({
      base,
      expanded,
      worktreePath: worktree.path,
      connectionId,
      terminalFileUriHostname
    })
    const relativePath = relativePathInsideRoot(worktree.path, absolutePath)
    // Cross-workspace retargeting is opt-in; older clients reuse their original workspace in files.open.
    const knownWorkspaceTarget =
      crossWorkspace && relativePath === null
        ? await this.host.resolveKnownWorkspaceFileTarget?.(absolutePath, target.executionHostId)
        : null
    const ownedWorktree = knownWorkspaceTarget?.worktree ?? worktree
    // Replace the full route with the path owner's; optional connection coalescing could stat a sibling local path on SSH.
    const ownedRoute = runtimeFileRouteForTarget(knownWorkspaceTarget ?? target)
    const ownedRelativePath = knownWorkspaceTarget?.relativePath ?? relativePath

    try {
      if (
        ownedRelativePath !== null &&
        (ownedRelativePath === '' || isSafeMobileRelativePath(ownedRelativePath))
      ) {
        const isDirectory =
          (
            await requireRuntimeFileProvider(knownWorkspaceTarget ?? target, this.host).stat(
              absolutePath
            )
          ).type === 'directory'
        return {
          worktree: ownedWorktree.id,
          relativePath: ownedRelativePath,
          absolutePath,
          exists: true,
          isDirectory,
          openTarget: isDirectory
            ? undefined
            : {
                kind: 'worktree-file',
                provider: ownedRoute.kind,
                relativePath: ownedRelativePath,
                absolutePath
              }
        }
      }

      // Why: grants read this machine; answering absent would let the client open its own same-path file instead.
      if (connectionId) {
        throw new Error(SSH_OUTSIDE_WORKSPACE_UNSUPPORTED_MESSAGE)
      }
      // Why: any caller allowed this method can already run commands as this host's user, so no path is off limits.
      return await this.artifacts.resolveAbsoluteFileGrant({
        worktreeId: worktree.id,
        absolutePath,
        clientId
      })
    } catch (error) {
      // Report genuine not-found as missing; let transport/permission errors surface so remote taps aren't all reported missing.
      if (isENOENT(error)) {
        return {
          ...empty,
          worktree: ownedWorktree.id,
          relativePath: ownedRelativePath,
          absolutePath
        }
      }
      throw error
    }
  }
}
