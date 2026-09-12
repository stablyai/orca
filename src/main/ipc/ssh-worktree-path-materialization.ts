import type { IFilesystemProvider } from '../providers/types'

export async function materializeSshWorktreePaths(
  provider: IFilesystemProvider | undefined,
  source: string,
  target: string,
  linkedPaths: readonly string[]
): Promise<string | undefined> {
  if (!provider?.materializeWorktreePaths) {
    return 'This SSH host cannot materialize workspace paths. Update the host and copy required files manually.'
  }
  try {
    const result = await provider.materializeWorktreePaths(source, target, linkedPaths)
    return result.supported
      ? result.warning
      : 'This SSH host cannot materialize workspace paths. Update the host and copy required files manually.'
  } catch (error) {
    console.warn('[worktree-materialization] Remote completion is unverifiable:', error)
    throw new Error(
      `Remote workspace path materialization is unverifiable. Workspace remains at "${target}". Setup was not prepared; confirm copying has exited before retrying or using its files.`,
      { cause: error }
    )
  }
}
