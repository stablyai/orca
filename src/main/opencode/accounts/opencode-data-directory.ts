import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

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

export function resolveOpenCodeDatabasePath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir()
): string | null {
  const selection = environment.OPENCODE_DB?.trim()
  if (selection === ':memory:') {
    return null
  }
  const dataDirectory = resolveOpenCodeDataDirectory(environment, homeDirectory)
  return selection && isAbsolute(selection)
    ? selection
    : join(dataDirectory, selection || 'opencode.db')
}
