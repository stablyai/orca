import { access } from 'node:fs/promises'
import { getJcodeSpawnHookEnvValue, getJcodeSpawnScriptPath } from './hook-settings'

export async function resolveJcodeSpawnHookEnv(args: {
  connectionId?: string | null
  wsl: boolean
}): Promise<string | undefined> {
  if (args.connectionId || args.wsl) {
    return undefined
  }
  const scriptPath = getJcodeSpawnScriptPath()
  try {
    await access(scriptPath)
    return getJcodeSpawnHookEnvValue(scriptPath)
  } catch {
    return undefined
  }
}
