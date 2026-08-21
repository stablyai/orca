export function pickRemoteCliEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const key of [
    'MCODE_TERMINAL_HANDLE',
    'MCODE_WORKTREE_ID',
    'MCODE_PANE_KEY',
    'MCODE_AGENT_LAUNCH_TOKEN',
    'MCODE_WORKSPACE_ID',
    'MCODE_USER_DATA_PATH',
    'PATH',
    'Path'
  ]) {
    const value = env[key]
    if (typeof value === 'string') {
      picked[key] = value
    }
  }
  return picked
}
