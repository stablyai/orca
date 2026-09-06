import { ClaudeRuntimeAuthFileStorage } from './runtime-auth-file-storage'
import type {
  ClaudeAuthIdentity,
  ClaudeReadBackMatch,
  ClaudeRefreshTokenComparison
} from './runtime-auth-types'

export class ClaudeRuntimeAuthCredentialIdentity extends ClaudeRuntimeAuthFileStorage {
  protected readIdentityFromCredentials(credentialsJson: string): ClaudeAuthIdentity | null {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(credentialsJson) as Record<string, unknown>
    } catch {
      return null
    }
    const oauth = this.asRecord(parsed.claudeAiOauth)
    return {
      accountUuid: this.normalizeField(
        this.readString(oauth, 'accountUuid') ?? this.readString(oauth, 'accountId')
      ),
      email: this.normalizeField(this.readString(oauth, 'email')),
      organizationUuid: this.normalizeField(
        this.readString(oauth, 'organizationUuid') ?? this.readString(oauth, 'organizationId')
      )
    }
  }

  protected isValidCredentialsJsonObject(credentialsJson: string): boolean {
    try {
      const parsed = this.asRecord(JSON.parse(credentialsJson))
      const oauth = this.asRecord(parsed?.claudeAiOauth)
      return this.normalizeField(this.readString(oauth, 'accessToken')) !== null
    } catch {
      return false
    }
  }

  protected runtimeCredentialsAreFresher(
    runtimeCredentialsJson: string,
    managedCredentialsJson: string
  ): boolean {
    const runtimeFreshness = this.readFreshnessFromCredentials(runtimeCredentialsJson)
    const managedFreshness = this.readFreshnessFromCredentials(managedCredentialsJson)
    return (
      runtimeFreshness !== null && managedFreshness !== null && runtimeFreshness > managedFreshness
    )
  }

  protected runtimeCredentialsAreOlder(
    runtimeCredentialsJson: string,
    managedCredentialsJson: string
  ): boolean {
    const runtimeFreshness = this.readFreshnessFromCredentials(runtimeCredentialsJson)
    const managedFreshness = this.readFreshnessFromCredentials(managedCredentialsJson)
    return (
      runtimeFreshness !== null && managedFreshness !== null && runtimeFreshness < managedFreshness
    )
  }

  protected chooseFreshestReadBackCandidate(
    candidates: {
      credentialsJson: string
      match: Extract<ClaudeReadBackMatch, { kind: 'matched' }>
    }[]
  ): {
    credentialsJson: string
    match: Extract<ClaudeReadBackMatch, { kind: 'matched' }>
  } {
    return candidates.reduce((freshest, candidate) => {
      const candidateFreshness = this.readFreshnessFromCredentials(candidate.credentialsJson)
      const freshestFreshness = this.readFreshnessFromCredentials(freshest.credentialsJson)
      if (
        candidateFreshness !== null &&
        (freshestFreshness === null || candidateFreshness > freshestFreshness)
      ) {
        return candidate
      }
      return freshest
    })
  }

  protected readFreshnessFromCredentials(credentialsJson: string): number | null {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(credentialsJson) as Record<string, unknown>
    } catch {
      return null
    }
    const oauth = this.asRecord(parsed.claudeAiOauth)
    return (
      this.readNumber(oauth, 'expiresAt') ??
      this.readNumber(oauth, 'expires_at') ??
      this.readNumber(oauth, 'expiry') ??
      this.readNumber(oauth, 'expires')
    )
  }

  protected compareRefreshTokens(
    runtimeCredentialsJson: string,
    managedCredentialsJson: string
  ): ClaudeRefreshTokenComparison {
    const runtimeRefreshToken = this.readRefreshTokenFromCredentials(runtimeCredentialsJson)
    const managedRefreshToken = this.readRefreshTokenFromCredentials(managedCredentialsJson)
    if (!runtimeRefreshToken || !managedRefreshToken) {
      return 'missing'
    }
    return runtimeRefreshToken === managedRefreshToken ? 'same' : 'different'
  }

  protected readRefreshTokenFromCredentials(credentialsJson: string): string | null {
    try {
      const parsed = JSON.parse(credentialsJson) as Record<string, unknown>
      const oauth = this.asRecord(parsed.claudeAiOauth)
      return this.normalizeField(this.readString(oauth, 'refreshToken'))
    } catch {
      return null
    }
  }

  protected readIdentityFromOauthAccount(oauthAccount: unknown): ClaudeAuthIdentity {
    const oauth = this.asRecord(oauthAccount)
    return {
      accountUuid: this.normalizeField(
        this.readString(oauth, 'accountUuid') ?? this.readString(oauth, 'accountId')
      ),
      email: this.normalizeField(
        this.readString(oauth, 'emailAddress') ?? this.readString(oauth, 'email')
      ),
      organizationUuid: this.normalizeField(
        this.readString(oauth, 'organizationUuid') ?? this.readString(oauth, 'organizationId')
      )
    }
  }

  protected asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    return value as Record<string, unknown>
  }

  protected readString(value: Record<string, unknown> | null, key: string): string | null {
    const candidate = value?.[key]
    return typeof candidate === 'string' ? candidate : null
  }

  protected readNumber(value: Record<string, unknown> | null, key: string): number | null {
    const candidate = value?.[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate
    }
    if (typeof candidate === 'string') {
      const parsed = Number(candidate)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }

  protected normalizeField(value: string | null | undefined): string | null {
    if (!value) {
      return null
    }
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }

  protected jsonValuesEqual(left: unknown, right: unknown): boolean {
    return (
      JSON.stringify(this.sortJsonValue(left ?? null)) ===
      JSON.stringify(this.sortJsonValue(right ?? null))
    )
  }

  protected sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sortJsonValue(item))
    }
    const record = this.asRecord(value)
    if (!record) {
      return value
    }
    return Object.fromEntries(
      Object.entries(record)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, nestedValue]) => [key, this.sortJsonValue(nestedValue)])
    )
  }
}
