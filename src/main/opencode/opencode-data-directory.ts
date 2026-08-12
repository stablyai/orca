import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveOpenCodeDataDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir()
): string {
  const xdgDataHome = environment.XDG_DATA_HOME?.trim()
  return join(xdgDataHome || join(homeDirectory, '.local', 'share'), 'opencode')
}

export function resolveOpenCodeStorageDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir()
): string {
  return join(resolveOpenCodeDataDirectory(environment, homeDirectory), 'storage')
}
