import { dirname } from 'node:path'
import { setAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { createNodeServiceEnvironment } from '../../backend/node-service-environment'
import { resolveOrcadPath } from '../../orcad/host-runtime/orcad-app-paths'

async function main(): Promise<void> {
  const [userData, profileId, appPath, version, cliLauncher] = process.argv.slice(2)
  if (!userData || !profileId || !appPath || !version) {
    throw new Error('Missing local chat host launch arguments')
  }
  process.env.ORCA_USER_DATA = userData
  process.env.ORCA_USER_DATA_PATH = userData
  // Electron's Node mode omits resourcesPath. Packaged provider executables and workers use it.
  if (appPath.endsWith('.asar') && !process.resourcesPath) {
    Object.defineProperty(process, 'resourcesPath', { value: dirname(appPath) })
  }
  const { environment } = createNodeServiceEnvironment({
    getPath: resolveOrcadPath,
    getAppPath: () => appPath,
    getVersion: () => version,
    isPackaged: () => appPath.endsWith('.asar'),
    getCliLauncherPath: () => cliLauncher
  })
  setAppEnvironment(environment)
  const { serveLocalChat } = await import('./local-chat-host-server')
  await serveLocalChat(userData, profileId)
}

void main().catch((error: unknown) => {
  console.error('[local-chat-host]', error)
  process.exit(1)
})
