import { createGitOperationExecutor } from '../../command-runner/admission/git-operation-executor'

export const worktreeCreateGit = createGitOperationExecutor('interactive')

export const worktreePreparationGit = createGitOperationExecutor('status')
