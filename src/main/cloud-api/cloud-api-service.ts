// Whether this build has an Orca Cloud control plane (ORCA_CLOUD_SANDBOX_URL), which decides if
// Settings shows the Orca Cloud pages. API keys, connected apps and routines are managed in the web
// console; the desktop only links there.
import { app } from 'electron'
import type { CloudApiAvailability } from '../../shared/cloud-api/cloud-api-types'
import { withCloudBuildDefaults } from '../cloud-build-defaults'
import { getHostedSandboxConfig } from '../hosted-sandbox/hosted-sandbox-config'

export function getCloudApiAvailability(): CloudApiAvailability {
  const config = getHostedSandboxConfig(
    app.getPath('userData'),
    withCloudBuildDefaults(process.env),
    app.isPackaged
  )
  return config
    ? { status: 'ready', controlPlaneUrl: config.controlPlaneUrl }
    : { status: 'unconfigured' }
}
