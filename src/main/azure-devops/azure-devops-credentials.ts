import { Buffer } from 'node:buffer'
import {
  normalizeAzureDevOpsAuthMethod,
  type AzureDevOpsAuthMethod
} from '../../shared/source-control/azure-devops-auth-types'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'
import {
  acquireAzureCliAccessToken,
  AzureDevOpsAuthError,
  type AzureCliAccessToken
} from './azure-cli-access-token'

export type AzureDevOpsCredentials = {
  headers: Record<string, string>
  credentialAvailable: boolean
} & ({ method: 'environment' } | { method: 'azure-cli'; generation: number; expiresAtMs: number })

type AuthStore = Pick<RuntimeStore, 'onSettingsChanged'> & {
  getSettings?: () => { azureDevOpsAuthMethod?: AzureDevOpsAuthMethod }
}
const REFRESH_MARGIN_MS = 5 * 60_000
type AuthSource = { store: AuthStore | null; cleanup?: () => void }
let source: AuthSource | undefined
let generation = 0
let cached: AzureCliAccessToken | undefined
let pending: Promise<AzureCliAccessToken> | undefined
let forcePathRefresh = false

export function getAzureDevOpsAuthMethod(): AzureDevOpsAuthMethod {
  return normalizeAzureDevOpsAuthMethod(source?.store?.getSettings?.().azureDevOpsAuthMethod)
}

export function installAzureDevOpsAuthSource(
  store: AuthStore | null,
  invalidateStatus: () => void = () => {}
): () => void {
  source?.cleanup?.()
  const installed: AuthSource = { store }
  source = installed
  invalidateAzureDevOpsCredentials()
  invalidateStatus()

  let method = getAzureDevOpsAuthMethod()
  installed.cleanup = store?.onSettingsChanged?.((updates) => {
    if (source !== installed || !('azureDevOpsAuthMethod' in updates)) {
      return
    }
    const next = getAzureDevOpsAuthMethod()
    if (method !== next) {
      method = next
      invalidateAzureDevOpsCredentials()
      invalidateStatus()
    }
  })
  return () => {
    if (source === installed) {
      installed.cleanup?.()
      source = undefined
      invalidateAzureDevOpsCredentials()
      invalidateStatus()
    }
  }
}

export function invalidateAzureDevOpsCredentials(options?: {
  generation?: number
  forcePathRefresh?: boolean
}): void {
  if (options?.generation !== undefined && options.generation !== generation) {
    return
  }
  generation++
  cached = undefined
  pending = undefined
  forcePathRefresh ||= options?.forcePathRefresh === true
}

function acquireForGeneration(started: number): Promise<AzureCliAccessToken> {
  if (!pending) {
    pending = acquireAzureCliAccessToken({ forcePathRefresh })
      .then((token) => {
        if (started === generation && getAzureDevOpsAuthMethod() === 'azure-cli') {
          cached = token
        }
        return token
      })
      .finally(() => {
        if (started === generation) {
          pending = undefined
        }
      })
    forcePathRefresh = false
  }
  return pending
}

function environmentCredentials(): AzureDevOpsCredentials {
  const accessToken = process.env.ORCA_AZURE_DEVOPS_ACCESS_TOKEN?.trim()
  if (accessToken) {
    return {
      method: 'environment',
      headers: { Authorization: `Bearer ${accessToken}` },
      credentialAvailable: true
    }
  }

  const pat =
    process.env.ORCA_AZURE_DEVOPS_TOKEN?.trim() || process.env.ORCA_AZURE_DEVOPS_PAT?.trim()
  if (pat) {
    const username = process.env.ORCA_AZURE_DEVOPS_USERNAME?.trim() ?? ''
    const encoded = Buffer.from(`${username}:${pat}`).toString('base64')
    return {
      method: 'environment',
      headers: { Authorization: `Basic ${encoded}` },
      credentialAvailable: true
    }
  }

  return { method: 'environment', headers: {}, credentialAvailable: false }
}

export function azureDevOpsEnvironmentTokenConfigured(): boolean {
  return Boolean(
    process.env.ORCA_AZURE_DEVOPS_ACCESS_TOKEN?.trim() ||
    process.env.ORCA_AZURE_DEVOPS_TOKEN?.trim() ||
    process.env.ORCA_AZURE_DEVOPS_PAT?.trim()
  )
}

export function assertAzureDevOpsCredentialsCurrent(credentials: AzureDevOpsCredentials): void {
  if (
    credentials.method !== getAzureDevOpsAuthMethod() ||
    (credentials.method === 'azure-cli' && credentials.generation !== generation)
  ) {
    throw new AzureDevOpsAuthError('token-acquisition-failed')
  }
  if (credentials.method === 'azure-cli' && credentials.expiresAtMs <= Date.now()) {
    throw new AzureDevOpsAuthError('invalid-token-response')
  }
}

export async function resolveAzureDevOpsCredentials(): Promise<AzureDevOpsCredentials> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (getAzureDevOpsAuthMethod() === 'environment') {
      return environmentCredentials()
    }
    if (cached && cached.expiresAtMs - Date.now() <= REFRESH_MARGIN_MS) {
      invalidateAzureDevOpsCredentials()
    }
    const started = generation
    const isCurrent = () => started === generation && getAzureDevOpsAuthMethod() === 'azure-cli'
    try {
      const token = cached ?? (await acquireForGeneration(started))
      if (!isCurrent()) {
        continue
      }
      if (token.expiresAtMs <= Date.now()) {
        throw new AzureDevOpsAuthError('invalid-token-response')
      }
      return {
        method: 'azure-cli',
        generation: started,
        expiresAtMs: token.expiresAtMs,
        headers: { Authorization: `Bearer ${token.accessToken}` },
        credentialAvailable: true
      }
    } catch (error) {
      if (isCurrent()) {
        throw error
      }
    }
  }
  throw new AzureDevOpsAuthError('token-acquisition-failed')
}
