import type { IFilesystemProvider } from '../providers/types'

export async function materializeSshWorktreePaths(
  provider: IFilesystemProvider | undefined,
  source: string,
  target: string,
  linkedPaths: readonly string[],
  copyPaths?: readonly string[]
): Promise<string | undefined> {
  try {
    const result = await provider?.materializeWorktreePaths?.(
      source,
      target,
      linkedPaths,
      copyPaths
    )
    return result?.supported
      ? result.warning
      : 'This SSH host cannot materialize workspace paths. Update the host and copy required files manually.'
  } catch (error) {
    console.warn('[worktree-materialization] Remote completion is unverifiable:', error)
    throw new Error(
      `Remote workspace path materialization is unverifiable. Workspace remains at "${target}". Setup was not prepared; confirm copying has exited before retrying or using its files. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
}
