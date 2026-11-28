// A teammate's file reads in the shared bot's home folder. Admission names that folder's workspace and
// resolves the path (symlinks followed) inside it; the read then runs on that symlink-free path with
// symlinks off whatever was asked or set, and is checked again once it has run, so a part of the path
// swapped for a symlink meanwhile answers nothing. A watch ends if its folder moves or is replaced.
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { BotFolderRead } from '../../../shared/bots/bot-share-rpc-methods'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'

type FolderSources = Pick<OrcaRuntimeService, 'bots' | 'resolveRuntimeFileTarget'>

/** The read as it may run: the folder's real path, and the path in it with every symlink resolved. */
export type ConfinedFolderRead = { realRoot: string; relativePath: string }

export async function confineBotShareFolderRead(
  runtime: FolderSources,
  scope: Pick<BotShareCallerScope, 'botId'>,
  read: BotFolderRead | undefined
): Promise<ConfinedFolderRead | null> {
  const bot = runtime.bots.list().find((entry) => entry.id === scope.botId)
  if (!bot || !read || !namesHome(read.worktree, bot.folderWorkspaceId)) {
    return null
  }
  const target = await runtime.resolveRuntimeFileTarget(read.worktree).catch(() => null)
  if (!target || target.executionHostId !== 'local') {
    return null
  }
  return resolveInside(target.worktree.path, read.relativePath ?? '')
}

/** The params a read runs with: symlinks off, and its path the one admission resolved. */
export function confinedFolderParams(params: unknown, confined: ConfinedFolderRead): unknown {
  const fields = params && typeof params === 'object' ? params : {}
  return {
    ...fields,
    followSymlinks: false,
    ...('relativePath' in fields ? { relativePath: confined.relativePath } : {})
  }
}

/** The folder's identity now, to tell later whether a watch still watches it. */
export async function folderIdentity(realRoot: string): Promise<string | null> {
  const [real, info] = await Promise.all([realpath(realRoot), stat(realRoot)]).catch(() => [
    null,
    null
  ])
  return real && info ? `${real}\0${info.dev}\0${info.ino}` : null
}

/** Only the home's own key, bare or as clients send it (`id:`), so no other spelling (a path, a
 *  name) can name another workspace. */
function namesHome(selector: string, folderWorkspaceId: string): boolean {
  const home = folderWorkspaceKey(folderWorkspaceId)
  return selector === home || selector === `id:${home}`
}

/** `relativePath` under `root` after every symlink on the way resolves, or null outside it. */
async function resolveInside(
  root: string,
  relativePath: string
): Promise<ConfinedFolderRead | null> {
  if (
    isAbsolute(relativePath) ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.split(/[\\/]/).includes('..')
  ) {
    return null
  }
  const [realRoot, realTarget] = await Promise.all([
    realpath(root),
    realpath(resolve(root, relativePath))
  ]).catch(() => [null, null])
  if (!realRoot || !realTarget) {
    return null
  }
  const within = relative(realRoot, realTarget)
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    return null
  }
  // The read joins this to the folder's path; a symlink-free path needs no further resolving.
  return { realRoot, relativePath: within === '' ? '' : within.split(sep).join('/') }
}
