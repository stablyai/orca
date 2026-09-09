import { ipcMain } from 'electron'
import type { GitBlameResult } from '../../../shared/git-blame'
import { getBlame } from '../../git/blame'
import {
	getSshGitProvider,
	SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../../providers/ssh-git-dispatch'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { validateGitRelativeFilePath } from '../filesystem-path-containment'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

export function registerFilesystemGitBlameHandlers(context: FilesystemHandlerContext): void {
	const { store, gitBlameCancellations } = context
	ipcMain.handle(
		'git:blame',
		async (
			event,
			args: {
				worktreePath: string
				relativePath: string
				connectionId?: string
				requestToken?: string
			}
		): Promise<GitBlameResult> => {
			const controller = gitBlameCancellations.begin(event, args.requestToken)
			try {
				if (args.connectionId) {
					const provider = getSshGitProvider(args.connectionId)
					if (!provider) {
						throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
					}
					return await provider.getBlame(args.worktreePath, args.relativePath, {
						signal: controller?.signal
					})
				}
				const resolvedWorktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
				const relativePath = validateGitRelativeFilePath(resolvedWorktreePath, args.relativePath)
				const gitOptions = getLocalGitOptionsForRegisteredWorktree(
					store,
					args.worktreePath,
					resolvedWorktreePath
				)
				return await getBlame(resolvedWorktreePath, relativePath, {
					...gitOptions,
					signal: controller?.signal
				})
			} finally {
				gitBlameCancellations.finish(event, args.requestToken, controller)
			}
		}
	)
	ipcMain.handle('git:cancelBlame', (event, args: { requestToken: string }): void => {
		gitBlameCancellations.cancel(event, args.requestToken)
	})
}
