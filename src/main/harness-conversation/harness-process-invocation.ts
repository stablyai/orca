import { getSpawnArgsForWindows, resolveWindowsCommand } from '../win32-utils'

export function harnessProcessInvocation(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): { command: string; args: string[] } {
  const resolved = resolveWindowsCommand(command, env)
  const invocation = getSpawnArgsForWindows(resolved, args)
  return { command: invocation.spawnCmd, args: invocation.spawnArgs }
}
