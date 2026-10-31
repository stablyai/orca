import { createGitOperationExecutor } from './command-runner/git-operation-executor'

export const worktreeCreateGit = createGitOperationExecutor('interactive')

export const worktreePreparationGit = createGitOperationExecutor('status')
