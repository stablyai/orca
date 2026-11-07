import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import type { CodexSystemDefaultIdentity } from '../../shared/managed-account-types'
import { readCodexAuthIdentity, type CodexAuthIdentity } from './codex-auth-identity'
import {
  credentialStoreMayBypassAuthJson,
  readCodexCredentialStoreMode
} from './codex-credential-store-mode'
import { systemDefaultCodexLoginStatus } from './codex-cli-login-status'
import { ManagedCodexHomeTemporarilyUnavailableError } from './host-codex-managed-home-ownership'

export type ResolvedCodexIdentity = CodexAuthIdentity

/** API-key logins carry no OAuth identity even when a stale `tokens` blob is still present. */
function declaresApiKeyCredential(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false
  }
  const apiKey = (parsed as Record<string, unknown>).OPENAI_API_KEY
  return typeof apiKey === 'string' && apiKey.trim() !== ''
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
    if (declaresApiKeyCredential(parsed)) {
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
  resolveSystemDefault(): CodexSystemDefaultIdentity {
    let contents: string
    try {
      contents = readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf-8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        if (this.hasEnvApiKey()) {
          // Environment API keys can authenticate without an auth.json file.
          return this.systemDefaultIdentity(false, 'api-key')
        }
        return this.resolveSystemDefaultFromConfiguredStore()
      }
      console.warn(
        '[codex-accounts] Failed to read system-default Codex identity',
        code ?? 'unknown-error'
      )
      return this.systemDefaultIdentity(true, 'none')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(contents)
    } catch {
      // Keep malformed credentials out of parser error logs.
      console.warn('[codex-accounts] System-default Codex auth is not valid JSON')
      return this.configuredStoreIdentity(true, 'none')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[codex-accounts] System-default Codex auth has an unexpected format')
      return this.configuredStoreIdentity(true, 'none')
    }
    if (declaresApiKeyCredential(parsed)) {
      return this.systemDefaultIdentity(true, 'api-key')
    }

    const identity = readCodexAuthIdentity(contents)
    if (!identity) {
      // The file cannot establish the active login; the configured store may still hold it.
      return this.configuredStoreIdentity(true, 'none')
    }
    return {
      hasAuth: true,
      authKind: 'oauth',
      email: identity.email ?? null,
      providerAccountId: identity.providerAccountId ?? null,
      workspaceLabel: identity.workspaceLabel ?? null
    }
  }

  /** A keyring-backed login never writes auth.json, so ask Codex about its configured store. */
  private resolveSystemDefaultFromConfiguredStore(): CodexSystemDefaultIdentity {
    return this.configuredStoreIdentity(false, 'none')
  }

  /** Prefer a cached keyring login when auth.json is absent or cannot establish one. */
  private configuredStoreIdentity(
    hasAuthWithoutStore: boolean,
    authKindWithoutStore: CodexSystemDefaultIdentity['authKind']
  ): CodexSystemDefaultIdentity {
    const fallback = this.systemDefaultIdentity(hasAuthWithoutStore, authKindWithoutStore)
    if (
      !credentialStoreMayBypassAuthJson(readCodexCredentialStoreMode(this.systemCodexConfigPath()))
    ) {
      return fallback
    }
    const loginStatus = systemDefaultCodexLoginStatus.read()
    if (loginStatus?.authenticated) {
      return this.systemDefaultIdentity(true, loginStatus.authKind)
    }
    // The CLI holds the only copy of the answer; refresh it for the next snapshot.
    systemDefaultCodexLoginStatus.refreshIfStale()
    return fallback
  }

  /** Awaited before `list` so Settings sees keyring-backed sign-ins without a second fetch. */
  async refreshSystemDefaultLoginStatus(): Promise<void> {
    if (this.hasUsableSystemAuth()) {
      return
    }
    if (
      !credentialStoreMayBypassAuthJson(readCodexCredentialStoreMode(this.systemCodexConfigPath()))
    ) {
      return
    }
    await systemDefaultCodexLoginStatus.refresh()
  }

  /** A present file answers forward only when it names a login Orca can actually use. */
  private hasUsableSystemAuth(): boolean {
    try {
      const contents = readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf-8')
      const parsed: unknown = JSON.parse(contents)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return false
      }
      return declaresApiKeyCredential(parsed) || readCodexAuthIdentity(contents) !== null
    } catch {
      return false
    }
  }

  private systemCodexConfigPath(): string {
    return join(homedir(), '.codex', 'config.toml')
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
