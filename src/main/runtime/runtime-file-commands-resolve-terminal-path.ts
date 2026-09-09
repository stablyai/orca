// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithReadMobileFile } from './runtime-file-commands-read-mobile-file'
import { RuntimeFileCommandsWithActiveRuntimeTextSearches as RuntimeFileCommands } from './runtime-file-commands-active-runtime-text-searches'
import type {
  RuntimeNativeChatFileContext,
  RuntimeTerminalPathResolution
} from '../../shared/runtime-types'
import { parseWslPath } from '../wsl'
import { relativePathInsideRoot, resolveRuntimePath } from '../../shared/cross-platform-path'
import { homedir } from 'node:os'
import {
  provenancePathCandidate,
  resolveTerminalAbsolutePath
} from './runtime-file-commands-terminal-file-paths'
import { stat } from 'node:fs/promises'
import { runtimeFileRouteForTarget } from './runtime-file-command-target'
import { isSafeMobileRelativePath } from './runtime-file-command-host'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { isENOENT } from '../ipc/filesystem-path-containment'
import type { RuntimeFileStatLike } from './runtime-file-commands-mobile-file-list-limit'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'

export class RuntimeFileCommandsWithResolveTerminalPath extends RuntimeFileCommandsWithReadMobileFile {
  // Resolves a mobile terminal tap to a worktree-relative path; relatives resolve against cwd, else the worktree root.
  async resolveTerminalPath(
    worktreeSelector: string,
    pathText: string,
    cwd?: string | null,
    clientId?: string,
    terminalHandle?: string | null,
    crossWorkspace?: boolean,
    nativeChatContext?: RuntimeNativeChatFileContext | null
  ): Promise<RuntimeTerminalPathResolution> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree } = target
    const route = runtimeFileRouteForTarget(target)
    const connectionId = route.kind === 'ssh' ? route.connectionId : undefined
    // Why: mobile may attach after OSC7 cwd was emitted; the runtime still owns the terminal's latest cwd to resolve the tap.
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

    // Why: SSH/WSL homes are unknown here; native-chat grants must not expand their ~/… paths against the local host home.
    const isTilde = pathText.startsWith('~/') || pathText.startsWith('~\\')
    if (isTilde && (connectionId || (nativeChatContext && parseWslPath(worktree.path)))) {
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
    // Why: clients that predate crossWorkspace reuse their own worktree id for the
    // follow-up files.open, so retargeting to a sibling workspace must be opt-in.
    const knownWorkspaceTarget =
      crossWorkspace && relativePath === null
        ? await this.host.resolveKnownWorkspaceFileTarget?.(absolutePath, target.executionHostId)
        : null
    const ownedWorktree = knownWorkspaceTarget?.worktree ?? worktree
    // Why: the owner's host replaces this target's outright. Coalescing an optional connection
    // instead let a sibling workspace resolved as `local` inherit this worktree's SSH target and
    // stat a local path on the remote host.
    const ownedRoute = runtimeFileRouteForTarget(knownWorkspaceTarget ?? target)
    const ownedRelativePath = knownWorkspaceTarget?.relativePath ?? relativePath

    try {
      if (
        ownedRelativePath !== null &&
        (ownedRelativePath === '' || isSafeMobileRelativePath(ownedRelativePath))
      ) {
        const stats =
          ownedRoute.kind === 'ssh'
            ? await this.statRemoteTerminalPath(absolutePath, ownedRoute.connectionId)
            : await stat(await resolveAuthorizedPath(absolutePath, store))
        return {
          worktree: ownedWorktree.id,
          relativePath: ownedRelativePath,
          absolutePath,
          exists: true,
          isDirectory: stats.isDirectory(),
          openTarget: stats.isDirectory()
            ? undefined
            : {
                kind: 'worktree-file',
                provider: ownedRoute.kind,
                relativePath: ownedRelativePath,
                absolutePath
              }
        }
      }

      if (
        nativeChatContext &&
        (await this.host.hasRecentNativeChatOutputPath?.(
          worktree.id,
          nativeChatContext,
          pathText,
          absolutePath
        ))
      ) {
        const artifactPath = await this.resolveNativeChatArtifactPath(absolutePath, connectionId)
        return await this.resolveAbsoluteFileGrant({
          worktreeId: worktree.id,
          artifactPath,
          connectionId,
          clientId,
          readOnly: true,
          provenance: 'native-chat'
        })
      }

      // Why: mobile taps may hit agent artifacts outside the worktree; grant the exact path, not arbitrary absolute paths.
      if (!normalizedTerminalHandle || !terminalCwd) {
        return { ...empty, relativePath, absolutePath }
      }
      const terminalContext = this.host.resolveTerminalContext?.(normalizedTerminalHandle)
      if (
        !terminalContext ||
        terminalContext.worktreeId !== worktree.id ||
        (terminalContext.connectionId ?? undefined) !== connectionId
      ) {
        return { ...empty, relativePath, absolutePath }
      }
      const artifactPath = await this.resolveAllowedTerminalArtifactPath({
        absolutePath,
        connectionId,
        worktreePath: worktree.path
      })
      if (!artifactPath) {
        return { ...empty, relativePath, absolutePath }
      }
      if (
        !(await this.host.hasRecentTerminalOutputPath?.(
          normalizedTerminalHandle,
          provenancePathCandidate(pathText, absolutePath),
          artifactPath
        ))
      ) {
        return { ...empty, relativePath, absolutePath }
      }
      return await this.resolveAbsoluteFileGrant({
        worktreeId: worktree.id,
        artifactPath,
        rejectedAbsolutePath: absolutePath,
        connectionId,
        clientId
      })
    } catch (error) {
      // Report genuine not-found as missing; let transport/permission errors surface so remote taps aren't all reported missing.
      if (
        isENOENT(error) ||
        (ownedRoute.kind === 'ssh' && RuntimeFileCommands.isRemoteNotFoundErrorMessage(error))
      ) {
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

  // Leaf helper: only ever reached from a route already resolved to `ssh`, so the id it takes is
  // this client's dialable target rather than a repo row's raw `connectionId`.
  protected async statRemoteTerminalPath(
    absolutePath: string,
    connectionId: string
  ): Promise<RuntimeFileStatLike & { isDirectory: () => boolean }> {
    const stats = await requireSshFilesystemProvider(connectionId).stat(absolutePath)
    return { ...stats, isDirectory: () => stats.type === 'directory' }
  }
}
