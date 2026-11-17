import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type ServiceUrlKey =
  | 'authApiUrl'
  | 'relayDirectorUrl'
  | 'pushGatewayUrl'
  | 'connectorUrl'
  | 'artifactsApiUrl'

type BuildDefaultsFile = Partial<Record<ServiceUrlKey, string>> & {
  billingApiUrl?: string
  cloudSandboxUrl?: string
  allowDevSigning?: boolean
}

// Build-time service URL defaults; an unset key keeps the main-process literal default.
const SERVICE_URL_ENV: Record<ServiceUrlKey, string> = {
  authApiUrl: 'ORCA_BUILD_CLOUD_API_URL',
  relayDirectorUrl: 'ORCA_BUILD_RELAY_URL',
  pushGatewayUrl: 'ORCA_BUILD_PUSH_GATEWAY_URL',
  connectorUrl: 'ORCA_BUILD_CONNECTOR_URL',
  artifactsApiUrl: 'ORCA_BUILD_ARTIFACTS_API_URL'
}
const SERVICE_URL_KEYS: readonly ServiceUrlKey[] = [
  'authApiUrl',
  'relayDirectorUrl',
  'pushGatewayUrl',
  'connectorUrl',
  'artifactsApiUrl'
]

function serviceUrl(name: string, value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }
  // Fail the build rather than ship a default the app would reject at run time.
  const url = URL.canParse(trimmed) ? new URL(trimmed) : null
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(`${name} must be an https origin`)
  }
  return url.origin
}

function readDefaultsFile(): BuildDefaultsFile {
  return JSON.parse(readFileSync(resolve('config/cloud-build-defaults.json'), 'utf8'))
}

/** Integration-branch backends baked into main (packaged builds read no shell env); build-time env overrides the file. */
export function cloudBuildDefaultsDefine(
  env: NodeJS.ProcessEnv = process.env,
  file: BuildDefaultsFile = readDefaultsFile()
): string {
  const serviceUrls: Partial<Record<ServiceUrlKey, string>> = {}
  for (const key of SERVICE_URL_KEYS) {
    const envName = SERVICE_URL_ENV[key]
    serviceUrls[key] = serviceUrl(envName, env[envName] || file[key])
  }
  return JSON.stringify({
    billingApiUrl: env.ORCA_BUILD_BILLING_API_URL || file.billingApiUrl,
    cloudSandboxUrl: env.ORCA_BUILD_CLOUD_SANDBOX_URL || file.cloudSandboxUrl,
    allowDevSigning: file.allowDevSigning === true,
    ...serviceUrls
  })
}
