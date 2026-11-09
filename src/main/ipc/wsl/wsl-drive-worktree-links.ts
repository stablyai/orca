import { join } from 'node:path'
import { readWorktreeLinks as readWorktreeAdminLinks } from '../../git/worktrees/removal/worktree-prune-guard'

export async function readWorktreeLinks(commonDir: string): Promise<string[]> {
  return (await readWorktreeAdminLinks(join(commonDir, 'worktrees'))).map(({ link }) => link)
}
