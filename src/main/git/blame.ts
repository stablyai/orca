import * as path from 'node:path'
import type { GitBlameResult } from '../../shared/git-blame'
import { parseGitBlamePorcelain } from '../../shared/git-blame'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'

export async function getBlame(
	worktreePath: string,
	relativePath: string,
	options: GitRuntimeOptions & { signal?: AbortSignal } = {}
): Promise<GitBlameResult> {
	const resolvedRelativePath = validateBlamePath(worktreePath, relativePath)
	const { stdout } = await gitExecFileAsync(
		['blame', '--line-porcelain', '--', resolvedRelativePath],
		{ ...gitOptionsForWorktree(worktreePath, options), signal: options.signal }
	)
	return parseGitBlamePorcelain(stdout)
}

function validateBlamePath(worktreePath: string, relativePath: string): string {
	if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
		throw new Error('Access denied: invalid git blame path')
	}
	const worktreeRoot = path.resolve(worktreePath)
	const resolvedPath = path.resolve(worktreeRoot, relativePath)
	const normalizedRelativePath = path.relative(worktreeRoot, resolvedPath)
	if (
		!normalizedRelativePath ||
		normalizedRelativePath === '..' ||
		normalizedRelativePath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(normalizedRelativePath)
	) {
		throw new Error('Access denied: git blame path escapes the selected worktree')
	}
	return normalizedRelativePath
}
