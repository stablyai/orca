import { isAbsolute } from 'node:path'
import { accessSync, constants } from 'node:fs'
import { RuntimeClientError } from './types'

const electron = process.env.ORCA_CLI_ELECTRON_EXECUTABLE
delete process.env.ORCA_CLI_ELECTRON_EXECUTABLE
const packagedElectron =
  process.platform === 'darwin' && electron && isAbsolute(electron) ? electron : null

export function getPackagedElectronExecutable(): string | null {
  return packagedElectron
}

/** App-owned operations retain the root app's update and process identity. */
export function reenterPackagedElectron(): void {
  if (!packagedElectron) {
    return
  }
  try {
    accessSync(packagedElectron, constants.X_OK)
    accessSync(process.argv[1], constants.R_OK)
  } catch {
    throw new RuntimeClientError(
      'app_not_found',
      'The installed Orca app is unavailable. Reinstall Orca and try again.'
    )
  }
  process.execve(packagedElectron, [packagedElectron, ...process.argv.slice(1)], {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1'
  })
}
