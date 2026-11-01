import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { RuntimeWorktreeRecord } from '../../shared/runtime-types'
import type { WorkspacePortHostScanResult } from '../../shared/workspace-ports'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { resolveCurrentAgentWorkspaceSelector } from '../agent-workspace-selector'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { formatPortsScan } from '../ports-format'
import {
  RuntimeClientError,
  RuntimeRpcFailureError,
  type RuntimeRpcSuccess
} from '../runtime-client'
import { normalizeWorktreeSelectorForCaller } from '../selectors'

type PortsTarget = { selector: string; worktreePath: string | null }

function isNativeFolderSelector(selector: string): boolean {
  return parseWorkspaceKey(selector.replace(/^id:/, ''))?.type === 'folder'
}

async function listFoldersAtPath(
  client: Pick<HandlerContext['client'], 'call'>,
  folderPath: string
): Promise<FolderWorkspace[]> {
  try {
    const { result } = await client.call<{ folderWorkspaces: FolderWorkspace[] }>(
      'folderWorkspace.list'
    )
    const target = normalizeRuntimePathForComparison(folderPath)
    return result.folderWorkspaces.filter(
      (row) => normalizeRuntimePathForComparison(row.folderPath) === target
    )
  } catch (error) {
    if (error instanceof RuntimeRpcFailureError && error.code === 'method_not_found') {
      return []
    }
    throw error
  }
}

async function worktreeIdAtSelector(
  client: Pick<HandlerContext['client'], 'call'>,
  selector: string
): Promise<string | null> {
  try {
    const shown = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree: selector
    })
    return shown.result.worktree.id
  } catch (error) {
    if (error instanceof RuntimeRpcFailureError && error.code === 'selector_not_found') {
      return null
    }
    throw error
  }
}

// Why: worktree path selectors never match a native folder, so a folder's path is named by its id.
async function resolveNativeFolderPathSelector(
  selector: string,
  client: Pick<HandlerContext['client'], 'call'>
): Promise<string> {
  if (!selector.startsWith('path:')) {
    return selector
  }
  const folders = await listFoldersAtPath(client, selector.slice('path:'.length))
  if (folders.length === 0) {
    return selector
  }
  const worktreeId = await worktreeIdAtSelector(client, selector)
  const candidates = [
    ...(worktreeId ? [`id:${worktreeId}`] : []),
    ...folders.map((row) => `folder:${row.id}`)
  ]
  // Why refuse: workspaces on different hosts can share a path, and guessing would scan the wrong host.
  if (candidates.length > 1) {
    throw new RuntimeClientError(
      'selector_ambiguous',
      `More than one workspace has this path. Pass one of: ${candidates.join(', ')}.`
    )
  }
  return `id:${candidates[0]}`
}

async function resolvePortsTarget(
  ctx: Pick<HandlerContext, 'flags' | 'cwd' | 'client'>,
  options: { needsWorktreePath: boolean }
): Promise<PortsTarget> {
  const { flags, cwd, client } = ctx
  const explicit = getOptionalStringFlag(flags, 'worktree')
  const selector =
    !explicit || explicit === 'active' || explicit === 'current'
      ? await resolveCurrentAgentWorkspaceSelector(cwd, client)
      : await resolveNativeFolderPathSelector(
          await normalizeWorktreeSelectorForCaller(explicit, cwd, client),
          client
        )
  if (!options.needsWorktreePath) {
    return { selector, worktreePath: null }
  }
  // Why refuse: Orca ties listeners only to repo-backed workspaces, and host-wide rows would hand
  // scripts another workspace's dev server.
  if (isNativeFolderSelector(selector)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Orca does not tie ports to native folder workspaces yet. Run `orca ports --all` to list every listener on the host.'
    )
  }
  const shown = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree: selector
  })
  return { selector, worktreePath: shown.result.worktree.git.path }
}

// Why: an older runtime has no host-scoped scan; its raw method_not_found reads as a CLI bug.
async function scanPortsOnWorkspaceHost(
  client: Pick<HandlerContext['client'], 'call'>,
  selector: string
): Promise<RuntimeRpcSuccess<WorkspacePortHostScanResult>> {
  try {
    return await client.call<WorkspacePortHostScanResult>('workspacePorts.scanHost', {
      worktree: selector
    })
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca runtime cannot list workspace ports yet. Update Orca and try again.'
      )
    }
    throw error
  }
}

// Why the path, not the id: folder workspace instances share one path, and attribution names only
// the first of them as owner.
function selectWorkspacePorts(
  scan: WorkspacePortHostScanResult,
  worktreePath: string | null
): WorkspacePortHostScanResult {
  const ports = scan.ports
    .filter(
      (port) =>
        worktreePath === null || (port.kind === 'workspace' && port.owner.path === worktreePath)
    )
    .sort((a, b) => a.port - b.port || (a.processName ?? '').localeCompare(b.processName ?? ''))
  return { ...scan, ports }
}

export const PORTS_HANDLERS: Record<string, CommandHandler> = {
  ports: async ({ flags, client, cwd, json }) => {
    const all = flags.get('all') === true
    const target = await resolvePortsTarget({ flags, cwd, client }, { needsWorktreePath: !all })
    const response = await scanPortsOnWorkspaceHost(client, target.selector)
    const worktreePath = all ? null : target.worktreePath
    const result = selectWorkspacePorts(response.result, worktreePath)
    printResult({ ...response, result }, json, (scan) =>
      formatPortsScan(scan, { showOwner: worktreePath === null })
    )
  }
}
