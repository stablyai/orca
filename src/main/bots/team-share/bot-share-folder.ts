// Whether a teammate's file read stays in the shared bot's home folder: it names that folder's
// workspace, and its path resolves (symlinks followed) inside it. Read-only methods alone take it.
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { BotFolderRead } from '../../../shared/bots/bot-share-rpc-methods'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'

type FolderSources = Pick<OrcaRuntimeService, 'bots' | 'resolveRuntimeFileTarget'>

export async function botShareFolderAdmits(
  runtime: FolderSources,
  scope: Pick<BotShareCallerScope, 'botId'>,
  read: BotFolderRead | undefined
): Promise<boolean> {
  const bot = runtime.bots.list().find((entry) => entry.id === scope.botId)
  if (!bot || !read || read.followSymlinks || !namesHome(read.worktree, bot.folderWorkspaceId)) {
    return false
  }
  const target = await runtime.resolveRuntimeFileTarget(read.worktree).catch(() => null)
  if (!target || target.executionHostId !== 'local') {
    return false
  }
  return pathInside(target.worktree.path, read.relativePath ?? '')
}

/** Only the home's own key, bare or as clients send it (`id:`), so no other spelling (a path, a
 *  name) can name another workspace. */
function namesHome(selector: string, folderWorkspaceId: string): boolean {
  const home = folderWorkspaceKey(folderWorkspaceId)
  return selector === home || selector === `id:${home}`
}

/** `relativePath` names the root or something under it, after every symlink on the way resolves. */
async function pathInside(root: string, relativePath: string): Promise<boolean> {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    return false
  }
  const [realRoot, realTarget] = await Promise.all([
    realpath(root),
    realpath(resolve(root, relativePath))
  ]).catch(() => [null, null])
  if (!realRoot || !realTarget) {
    return false
  }
  const within = relative(realRoot, realTarget)
  return within === '' || (!within.startsWith(`..${sep}`) && within !== '..' && !isAbsolute(within))
}
