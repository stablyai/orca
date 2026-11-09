import { app } from 'electron'
import { withCloudBuildDefaults } from '../../cloud-build-defaults'
import { getHostedSandboxConfig } from '../hosted-sandbox-config'
import {
  createHostedEnvironmentService,
  getHostedEnvironmentService,
  registerHostedEnvironmentService,
  type HostedEnvironmentService
} from './hosted-environment-service'

/** One service per process, built on first use so startup never reads the profile for it. */
export function installHostedEnvironmentService(): HostedEnvironmentService {
  const existing = getHostedEnvironmentService()
  if (existing) {
    return existing
  }
  const service = createHostedEnvironmentService(() =>
    getHostedSandboxConfig(
      app.getPath('userData'),
      withCloudBuildDefaults(process.env),
      app.isPackaged
    )
  )
  registerHostedEnvironmentService(service)
  return service
}
