import { homedir } from 'node:os'
import { join } from 'node:path'

export type MimocodeDirectories = Record<'config' | 'data' | 'cache' | 'state', string>

function readEnvironmentPath(
  environment: Record<string, string | undefined>,
  key: string
): string | undefined {
  const value = environment[key] ?? process.env[key]
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function resolveMimocodeDirectories(
  existingHome: string | undefined,
  environment: Record<string, string | undefined> = process.env
): MimocodeDirectories {
  if (existingHome) {
    return {
      config: join(existingHome, 'config'),
      data: join(existingHome, 'data'),
      cache: join(existingHome, 'cache'),
      state: join(existingHome, 'state')
    }
  }

  const homeDirectory = readEnvironmentPath(environment, 'HOME') || homedir()
  const configRoot =
    readEnvironmentPath(environment, 'XDG_CONFIG_HOME') || join(homeDirectory, '.config')
  const dataRoot =
    readEnvironmentPath(environment, 'XDG_DATA_HOME') || join(homeDirectory, '.local', 'share')
  const cacheRoot =
    readEnvironmentPath(environment, 'XDG_CACHE_HOME') || join(homeDirectory, '.cache')
  const stateRoot =
    readEnvironmentPath(environment, 'XDG_STATE_HOME') || join(homeDirectory, '.local', 'state')

  return {
    config: join(configRoot, 'mimocode'),
    data: join(dataRoot, 'mimocode'),
    cache: join(cacheRoot, 'mimocode'),
    state: join(stateRoot, 'mimocode')
  }
}
