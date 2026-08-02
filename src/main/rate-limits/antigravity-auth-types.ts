import type { UsageRateLimitFailureKind } from '../../shared/rate-limit-types'

export type AntigravityCredentialSource = 'official-keychain' | 'official-token-file'

export type AntigravityAccessToken = {
  accessToken: string
  credentialSource: AntigravityCredentialSource
  sourceKey: string
}

export class AntigravityAuthError extends Error {
  readonly failureKind: UsageRateLimitFailureKind
  readonly status: number | null

  constructor(
    message: string,
    failureKind: UsageRateLimitFailureKind,
    status: number | null = null
  ) {
    super(message)
    this.name = 'AntigravityAuthError'
    this.failureKind = failureKind
    this.status = status
  }
}

export type TokenEnvelope = {
  token: {
    access_token: string
    refresh_token?: string
    token_type?: string
    expiry?: string | number
  }
  [key: string]: unknown
}

export type ParsedCredentials = {
  source: AntigravityCredentialSource
  sourceKey: string
  tokenPath: string | null
  envelope: TokenEnvelope
  accessToken: string
  refreshToken: string
  expiresAtMs: number | null
  baseHomeDir: string
}

export type RefreshedCredentials = {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  idToken?: string
}
