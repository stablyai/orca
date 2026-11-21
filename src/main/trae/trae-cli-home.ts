import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../shared/file-access/absolute-dir-override'

export function resolveTraeCliHome(
  env: NodeJS.ProcessEnv = process.env,
  homePath = homedir()
): string {
  const shared = resolveAbsoluteDirOverride(env.TRAE_HOME, join(homePath, '.trae'))
  return resolveAbsoluteDirOverride(env.TRAECLI_HOME, join(shared, 'cli'))
}
