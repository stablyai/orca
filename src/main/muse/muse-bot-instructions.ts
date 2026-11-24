import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'
import { writeFolderContextFile } from '../acp/launch/acp-folder-context-file'
import type { AcpInstructionsLaunch } from '../acp/launch/acp-instructions'
import { botsRootFolder } from '../bots/bot-home'
import { realFolderUnderRoot } from '../filesystem/real-folder-under-root'

async function isOutsideGit(cwd: string): Promise<boolean> {
  for (let dir = cwd; ; dir = dirname(dir)) {
    try {
      // A linked worktree has a file here. A symlink is also unsafe.
      await lstat(join(dir, '.git'))
      return false
    } catch (error) {
      if (errnoCodeOrUnknown(error) !== 'ENOENT') {
        return false
      }
    }
    if (dirname(dir) === dir) {
      return true
    }
  }
}

export async function deliverMuseBotInstructions(
  { cwd, text }: { cwd: string; text: string },
  botsRoot = botsRootFolder()
): Promise<AcpInstructionsLaunch> {
  const root = resolve(botsRoot)
  const folder = resolve(cwd)
  const realRoot = await realpath(root).catch(() => null)
  const home = realRoot ? join(realRoot, basename(folder)) : null
  if (
    !realRoot ||
    !home ||
    dirname(folder) !== root ||
    (await realFolderUnderRoot(root, realRoot, [basename(folder)])) !== 'real' ||
    !(await lstat(join(home, 'bot.json')).catch(() => null))?.isFile() ||
    !(await isOutsideGit(home))
  ) {
    throw new Error('Muse standing instructions require an Orca bot home outside Git')
  }
  if (!(await writeFolderContextFile(home, 'AGENTS.md', 'Muse', text))) {
    throw new Error('Muse could not write standing instructions to AGENTS.md')
  }
  // Muse loads workspace rules and skills only when this launch trusts its managed bot home.
  return { args: ['--trust-workspace'] }
}
