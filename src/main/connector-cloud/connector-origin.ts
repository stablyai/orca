import { cleanCloudServiceOrigin } from '../../shared/cloud-service-url'
import { buildServiceUrlDefault } from '../cloud-build-defaults'

export function resolveConnectorOrigin(env: NodeJS.ProcessEnv, packaged: boolean): string {
  return (
    cleanCloudServiceOrigin(env.ORCA_CONNECTOR_URL, !packaged) ??
    buildServiceUrlDefault('connectorUrl', 'https://connector.onorca.dev')
  )
}
