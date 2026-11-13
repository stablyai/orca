import { cleanCloudServiceOrigin } from '../../../shared/cloud-service-url'
import { buildServiceUrlDefault } from '../../cloud-build-defaults'

export function resolvePushGatewayOrigin(env: NodeJS.ProcessEnv, packaged: boolean): string {
  return (
    cleanCloudServiceOrigin(env.ORCA_PUSH_GATEWAY_URL, !packaged) ??
    buildServiceUrlDefault('pushGatewayUrl', 'https://push.onorca.dev')
  )
}
