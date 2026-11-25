import { getSavedCloudServerSettings } from './profile-cloud-server-preferences'
export { installCloudServerSettingsReader } from './profile-cloud-server-preferences'
import {
  DEFAULT_CLOUD_SERVER,
  validateCustomCloudServer,
  type CustomCloudServerSettings
} from '../../../shared/settings/custom-cloud-server'
import {
  cleanCloudServiceUrl as cleanUrl,
  cleanCloudServiceOrigin as cleanOrigin
} from '../../../shared/network/cloud-service-url'
import { resolvePushGatewayOrigin } from '../../runtime/push/push-gateway-origin'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-lifecycle/app-environment'

export type OrcaCloudAuthConfig = {
  apiBaseUrl: string
  authorizeEndpoint: string
  sessionEndpoint: string
  refreshEndpoint: string
  capabilitiesEndpoint: string
  profileEndpoint: string
  orgEndpoint: string
  logoutEndpoint: string
  relayTokenEndpoint: string
  connectorTokenEndpoint: string
  relayDirectorUrl: string
  clientId: string
  scope: string
}

const DEFAULT_SCOPE = 'openid profile email offline_access'
const PRODUCTION_API_BASE_URL = DEFAULT_CLOUD_SERVER.authServerUrl
const PRODUCTION_CLIENT_ID = DEFAULT_CLOUD_SERVER.clientId
const PRODUCTION_RELAY_DIRECTOR_URL = DEFAULT_CLOUD_SERVER.relayDirectorUrl

// Packaged main omits NODE_ENV; use packaged status to gate development auth overrides.
// No installed environment (a bare Node import) reads as unpackaged, as Electron's absent `app` did.
export function isPackagedOrcaBuild(): boolean {
  return hasAppEnvironment() && getAppEnvironment().isPackaged()
}

function endpoint(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl}/`).toString()
}

export function getOrcaCloudAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = isPackagedOrcaBuild(),
  saved: CustomCloudServerSettings | undefined = getSavedCloudServerSettings()
): { configured: true; config: OrcaCloudAuthConfig } | { configured: false; setupMessage: string } {
  // Plain HTTP token endpoints are development-only.
  const allowLoopbackHttp = !packaged
  const cleanEndpointUrl = (value: string | undefined): string | null =>
    cleanUrl(value, allowLoopbackHttp)
  const environmentValues = [
    env.ORCA_CLOUD_API_URL?.trim(),
    env.ORCA_CLOUD_CLIENT_ID?.trim(),
    env.ORCA_RELAY_URL?.trim()
  ]
  const environmentOverride = environmentValues.some(Boolean)
  if (environmentOverride && !environmentValues.every(Boolean)) {
    return {
      configured: false,
      setupMessage: 'Set ORCA_CLOUD_API_URL, ORCA_CLOUD_CLIENT_ID and ORCA_RELAY_URL together.'
    }
  }
  const custom =
    !environmentOverride && saved?.enabled
      ? validateCustomCloudServer(saved, allowLoopbackHttp)
      : null
  if (!environmentOverride && saved?.enabled && !custom) {
    return { configured: false, setupMessage: 'The custom cloud server settings are invalid.' }
  }
  const apiBaseUrl = cleanEndpointUrl(
    environmentOverride
      ? env.ORCA_CLOUD_API_URL
      : custom?.authServerUrl || (packaged ? PRODUCTION_API_BASE_URL : undefined)
  )
  const clientId = environmentOverride
    ? env.ORCA_CLOUD_CLIENT_ID?.trim()
    : custom?.clientId || (packaged ? PRODUCTION_CLIENT_ID : undefined)
  const relayDirectorUrl = cleanOrigin(
    environmentOverride
      ? env.ORCA_RELAY_URL
      : custom?.relayDirectorUrl || PRODUCTION_RELAY_DIRECTOR_URL,
    allowLoopbackHttp
  )
  if (!apiBaseUrl || !clientId || !relayDirectorUrl) {
    return {
      configured: false,
      setupMessage: 'Orca Cloud sign-in is not configured for this build.'
    }
  }

  const authBaseUrl = cleanEndpointUrl(env.ORCA_CLOUD_AUTH_URL) ?? apiBaseUrl
  return {
    configured: true,
    config: {
      apiBaseUrl,
      authorizeEndpoint:
        cleanEndpointUrl(env.ORCA_CLOUD_AUTHORIZE_URL) ??
        endpoint(authBaseUrl, '/v1/desktop/auth/authorize'),
      sessionEndpoint:
        cleanEndpointUrl(env.ORCA_CLOUD_SESSION_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/session'),
      refreshEndpoint:
        cleanEndpointUrl(env.ORCA_CLOUD_REFRESH_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/refresh'),
      capabilitiesEndpoint:
        cleanEndpointUrl(env.ORCA_CLOUD_CAPABILITIES_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/capabilities'),
      profileEndpoint:
        cleanEndpointUrl(env.ORCA_CLOUD_PROFILE_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/profile'),
      orgEndpoint:
        cleanEndpointUrl(env.ORCA_CLOUD_ORG_URL) ?? endpoint(apiBaseUrl, '/v1/desktop/auth/org'),
      logoutEndpoint:
        cleanEndpointUrl(env.ORCA_CLOUD_LOGOUT_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/logout'),
      relayTokenEndpoint:
        cleanEndpointUrl(env.ORCA_CLOUD_RELAY_TOKEN_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/relay-token'),
      connectorTokenEndpoint:
        cleanEndpointUrl(env.ORCA_CLOUD_CONNECTOR_TOKEN_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/connector-token'),
      relayDirectorUrl,
      clientId,
      scope: env.ORCA_CLOUD_AUTH_SCOPE?.trim() || DEFAULT_SCOPE
    }
  }
}

/** Host-key authentication keeps phone push available without a signed-in account. */
export function getOrcaPushGatewayUrl(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = isPackagedOrcaBuild()
): string {
  return resolvePushGatewayOrigin(env, packaged)
}

export function allowsPlaintextOrcaCloudSession(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = isPackagedOrcaBuild()
): boolean {
  return (
    env.ORCA_CLOUD_ALLOW_PLAINTEXT_SESSION === '1' && env.NODE_ENV !== 'production' && !packaged
  )
}

export function isOrcaCloudDevAuthEnabled(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = isPackagedOrcaBuild()
): boolean {
  return env.ORCA_CLOUD_DEV_AUTH === '1' && env.NODE_ENV !== 'production' && !packaged
}
