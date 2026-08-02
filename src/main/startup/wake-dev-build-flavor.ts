import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { App } from 'electron'

export const WAKE_DEV_APP_ID = 'com.ram4dev.orca-wake-dev'
export const WAKE_DEV_APP_NAME = 'Orca Wake Dev'
export const WAKE_DEV_CLI_COMMAND = 'orca-wake'
export const WAKE_DEV_PROFILE_DIRECTORY = 'orca-wake-dev'

type PathName = 'userData' | 'sessionData' | 'logs' | 'crashDumps' | 'temp'

let configuredWakeDevBuild = false

export function configureWakeDevBuildFlavor(app: App, enabled: boolean): void {
  configuredWakeDevBuild = enabled
  if (!enabled) {
    return
  }

  const profileRoot = join(app.getPath('appData'), WAKE_DEV_PROFILE_DIRECTORY)
  const paths: [PathName, string][] = [
    ['userData', profileRoot],
    ['sessionData', join(profileRoot, 'cache')],
    ['logs', join(profileRoot, 'logs')],
    ['crashDumps', join(profileRoot, 'crash-dumps')],
    ['temp', join(profileRoot, 'runtime')]
  ]
  for (const [name, path] of paths) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    app.setPath(name, path)
  }

  process.env.ORCA_PACKAGED_COMMAND_NAME = WAKE_DEV_CLI_COMMAND
  process.env.ORCA_CONTROLLED_CODEX_SOCKET_ROOT = join(
    '/tmp',
    `ocw-wake-${process.getuid?.() ?? 'local'}`
  )
}

export function isWakeDevRuntime(): boolean {
  return configuredWakeDevBuild
}
