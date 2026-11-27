import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'

export function resolveProviderExecPath(platform: NodeJS.Platform = process.platform): string {
  const app = getAppEnvironment()
  if (!app.isPackaged()) {
    return join(
      app.getAppPath(),
      'native/provider-exec/.build',
      `${platform}-${process.arch}`,
      'orca-provider-exec'
    )
  }
  if (process.resourcesPath) {
    return platform === 'darwin'
      ? join(process.resourcesPath, '..', 'MacOS', 'orca-provider-exec')
      : join(process.resourcesPath, 'bin', 'orca-provider-exec')
  }
  return join(app.getAppPath(), 'bin', 'orca-provider-exec')
}
