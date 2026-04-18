import { listWorktrees } from './git/worktree';
import { isFolderRepo } from '../shared/repo-kind';
export function createFolderWorktree(repo) {
    return {
        path: repo.path,
        head: '',
        branch: '',
        isBare: false,
        // Why: folder mode has no linked worktree graph. Treat the folder itself
        // as the single primary worktree so the rest of Orca's worktree-first UI
        // can keep using one stable workspace identity.
        isMainWorktree: true
    };
}
export async function listRepoWorktrees(repo) {
    if (isFolderRepo(repo)) {
        return [createFolderWorktree(repo)];
    }
    return await listWorktrees(repo.path);
}
