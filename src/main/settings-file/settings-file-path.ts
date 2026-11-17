import { join } from 'node:path'

export function getUserSettingsFilePath(homePath: string): string {
  return join(homePath, '.orca', 'settings.json')
}
