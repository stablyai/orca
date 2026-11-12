import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import type { CodexSystemDefaultIdentity } from '../../shared/managed-account-types'
import { readCodexAuthIdentity, type CodexAuthIdentity } from './codex-auth-identity'
import { ManagedCodexHomeTemporarilyUnavailableError } from './host-codex-managed-home-ownership'

export type ResolvedCodexIdentity = CodexAuthIdentity

const PROVIDERS_WITHOUT_OPENAI_AUTH = new Set([
  'amazon-bedrock',
  'amazon-bedrock-runtime',
  'gcp',
  'ollama',
  'lmstudio'
])
const API_KEY_AUTH_MODES = new Set(['apikey', 'bedrockApiKey', 'bedrockAccessKeys'])

function resolveStoredAuthMode(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const auth = parsed as Record<string, unknown>
  if (auth.auth_mode != null) {
    return typeof auth.auth_mode === 'string' ? auth.auth_mode : null
  }
  if (auth.personal_access_token != null) {
    return 'personalAccessToken'
  }
  if (auth.bedrock_api_key != null) {
    return 'bedrockApiKey'
  }
  if (auth.bedrock_access_keys != null) {
    return 'bedrockAccessKeys'
  }
  if (auth.OPENAI_API_KEY != null) {
    return 'apikey'
  }
  return 'chatgpt'
}

function hasChatGptTokenIdentity(mode: string | null): boolean {
  return mode === 'chatgpt' || mode === 'chatgptAuthTokens'
}

export class CodexAccountIdentity {
  constructor(
    private readonly assertManagedHomePath: (
      candidatePath: string,
      expectedAccountId?: string
    ) => string | Promise<string>
  ) {}

  async readFromHome(
    managedHomePath: string,
    expectedAccountId: string
  ): Promise<ResolvedCodexIdentity> {
    return this.readFromTrustedHome(
      await this.assertManagedHomePath(managedHomePath, expectedAccountId)
    )
  }

  /** `trustedHomePath` has already passed the managed-home ownership check. */
  readFromTrustedHome(trustedHomePath: string): ResolvedCodexIdentity {
    const authFilePath = join(trustedHomePath, 'auth.json')
    let contents: string
    try {
      contents = readFileSync(authFilePath, 'utf-8')
    } catch (error) {
      // Preserve authenticated homes during rollback when credential reads fail transiently.
      if (isDefinitiveAbsence(error)) {
        throw error
      }
      throw new ManagedCodexHomeTemporarilyUnavailableError(undefined, { cause: error })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(contents)
    } catch {
      // Raw SyntaxError messages may expose credential bytes.
      throw new Error('Codex auth.json is corrupt or not valid JSON')
    }
    if (!hasChatGptTokenIdentity(resolveStoredAuthMode(parsed))) {
      return {
        email: null,
        providerAccountId: null,
        workspaceLabel: null,
        workspaceAccountId: null
      }
    }
    const identity = readCodexAuthIdentity(contents)
    if (!identity) {
      return {
        email: null,
        providerAccountId: null,
        workspaceLabel: null,
        workspaceAccountId: null
      }
    }
    return identity
  }

  // Resolve the system default live from ~/.codex rather than stored managed-account identity.
  resolveSystemDefault(provider: string | null): CodexSystemDefaultIdentity {
    const usesProviderAuth = provider !== null && PROVIDERS_WITHOUT_OPENAI_AUTH.has(provider)
    let contents: string
    try {
      contents = readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf-8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // Environment API keys can authenticate without an auth.json file.
        return this.systemDefaultIdentity(
          false,
          usesProviderAuth || this.hasEnvApiKey() ? 'api-key' : 'none'
        )
      }
      console.warn(
        '[codex-accounts] Failed to read system-default Codex identity',
        code ?? 'unknown-error'
      )
      return this.systemDefaultIdentity(true, usesProviderAuth ? 'api-key' : 'none')
    }

    if (usesProviderAuth) {
      return this.systemDefaultIdentity(true, 'api-key')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(contents)
    } catch {
      // Keep malformed credentials out of parser error logs.
      console.warn('[codex-accounts] System-default Codex auth is not valid JSON')
      return this.systemDefaultIdentity(true, 'none')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[codex-accounts] System-default Codex auth has an unexpected format')
      return this.systemDefaultIdentity(true, 'none')
    }
    const mode = resolveStoredAuthMode(parsed)
    if (!mode || API_KEY_AUTH_MODES.has(mode)) {
      return this.systemDefaultIdentity(true, mode ? 'api-key' : 'none')
    }

    const identity = hasChatGptTokenIdentity(mode) ? readCodexAuthIdentity(contents) : null
    return {
      hasAuth: true,
      authKind: 'oauth',
      email: identity?.email ?? null,
      providerAccountId: identity?.providerAccountId ?? null,
      workspaceLabel: identity?.workspaceLabel ?? null
    }
  }

  private systemDefaultIdentity(
    hasAuth: boolean,
    authKind: CodexSystemDefaultIdentity['authKind']
  ): CodexSystemDefaultIdentity {
    return {
      hasAuth,
      authKind,
      email: null,
      providerAccountId: null,
      workspaceLabel: null
    }
  }

  private hasEnvApiKey(): boolean {
    const key = process.env.OPENAI_API_KEY
    return typeof key === 'string' && key.trim() !== ''
  }
}
