export async function prepareWorkspaceShellAccount<T>(
  provider: 'codex' | 'claude',
  env: Record<string, string>,
  plainShell: boolean,
  prepare: () => Promise<T>
): Promise<T | null> {
  try {
    const result = await prepare()
    delete env[provider === 'codex' ? 'ORCA_CODEX_LAUNCH_ERROR' : 'ORCA_CLAUDE_LAUNCH_ERROR']
    return result
  } catch (error) {
    if (!plainShell) {
      throw error
    }
    env[provider === 'codex' ? 'ORCA_CODEX_LAUNCH_ERROR' : 'ORCA_CLAUDE_LAUNCH_ERROR'] =
      `The workspace ${provider} account is unavailable. Choose an available account in the workspace menu and open a new terminal.`
    return null
  }
}
