import { homedir, tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import {
  hasAppEnvironment,
  setAppEnvironment,
  type AppPathName
} from '../../../shared/app-lifecycle/app-environment'
import { createNodeServiceEnvironment } from '../../../main/backend/node-service-environment'
import { readOrcaCliVersion } from '../../cli-version'
import { getDefaultUserDataPath } from './metadata'

/** Main hook code resolves Orca's userData (Claude profile homes) through this port. */
export function ensureCliAppEnvironment(scriptPath = process.argv[1] ?? ''): void {
  if (hasAppEnvironment()) {
    return
  }
  // The bundled launcher runs <resources>/app.asar.unpacked/out/cli/index.js.
  const unpacked = scriptPath.indexOf(`${sep}app.asar.unpacked${sep}`)
  const appPath =
    unpacked === -1 ? dirname(scriptPath) : join(scriptPath.slice(0, unpacked), 'app.asar')
  const userData = getDefaultUserDataPath()
  const paths: Record<AppPathName, string> = {
    userData,
    home: homedir(),
    appData: dirname(userData),
    temp: tmpdir(),
    downloads: join(homedir(), 'Downloads'),
    logs: join(userData, 'logs'),
    exe: process.execPath
  }
  setAppEnvironment(
    createNodeServiceEnvironment({
      getPath: (name) => paths[name],
      getAppPath: () => appPath,
      getVersion: () => readOrcaCliVersion() ?? '0.0.0',
      isPackaged: () => unpacked !== -1
    }).environment
  )
}
