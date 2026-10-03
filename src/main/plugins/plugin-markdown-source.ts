import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { isWslUncPath } from '../../shared/wsl-paths'
import {
  pluginMarkdownSourceRequestSchema,
  type PluginMarkdownSourceRequest,
  type PluginMarkdownSourceResult
} from '../../shared/plugins/plugin-markdown-renderer'
import { isDescendantOrEqual } from '../ipc/filesystem-path-containment'
import type { TerminalWorkspaceLaunchScope } from '../runtime/runtime-legacy-worker-terminal-recovery-types'

export type PluginMarkdownSourceAuthority = {
  getRuntimeId(): string
  showTerminalWorkspaceLaunchScope(selector: string): Promise<TerminalWorkspaceLaunchScope>
}

export async function resolvePluginMarkdownSource(
  authority: PluginMarkdownSourceAuthority | null,
  raw: unknown
): Promise<PluginMarkdownSourceResult> {
  const parsed = pluginMarkdownSourceRequestSchema.safeParse(raw)
  if (!parsed.success || !authority) {
    return { status: 'unavailable', reason: 'unsupported-context' }
  }
  const request: PluginMarkdownSourceRequest = parsed.data
  if (
    request.runtimeEnvironmentId !== null ||
    request.worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
    !isAbsolute(request.documentPath) ||
    request.documentPath.includes('\0') ||
    isWslUncPath(request.documentPath) ||
    !/\.(?:md|mdown|markdown)$/i.test(request.documentPath)
  ) {
    return { status: 'unavailable', reason: 'unsupported-context' }
  }
  try {
    const scope = await authority.showTerminalWorkspaceLaunchScope(`id:${request.worktreeId}`)
    if (
      scope.id !== request.worktreeId ||
      scope.connectionId !== null ||
      (!scope.repo && !scope.folderWorkspace) ||
      (scope.repo && getRepoExecutionHostId(scope.repo) !== 'local') ||
      (scope.folderWorkspace && getRepoExecutionHostId(scope.folderWorkspace) !== 'local') ||
      !isAbsolute(scope.path) ||
      isWslUncPath(scope.path)
    ) {
      return { status: 'unavailable', reason: 'unsupported-context' }
    }
    const [workspacePath, documentPath] = await Promise.all([
      realpath(scope.path),
      realpath(request.documentPath)
    ])
    if (!isDescendantOrEqual(documentPath, workspacePath) || !(await stat(documentPath)).isFile()) {
      return { status: 'unavailable', reason: 'unsupported-context' }
    }
    return {
      status: 'resolved',
      source: {
        runtimeId: authority.getRuntimeId(),
        worktreeId: request.worktreeId,
        fileId: request.fileId,
        documentPath,
        workspacePath
      }
    }
  } catch {
    return { status: 'unavailable', reason: 'unsupported-context' }
  }
}
