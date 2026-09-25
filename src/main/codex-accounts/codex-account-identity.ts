import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import type { CodexSystemDefaultIdentity } from '../../shared/managed-account-types'
import { readCodexAuthIdentity, type CodexAuthIdentity } from './codex-auth-identity'
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
    ) => string
  ) {}

  readFromHome(managedHomePath: string, expectedAccountId: string): ResolvedCodexIdentity {
    const authFilePath = join(
      this.assertManagedHomePath(managedHomePath, expectedAccountId),
      'auth.json'
    )
    let contents: string
    try {
      contents = readFileSync(authFilePath, 'utf-8')
    } catch (error) {
      // Why: an unreadable auth.json is not a missing credential. Surfacing it as
      // a generic failure is what lets the add path's rollback delete a home
      // holding freshly authenticated bytes.
      if (isDefinitiveAbsence(error)) {
        throw error
      }
      throw new ManagedCodexHomeTemporarilyUnavailableError(undefined, { cause: error })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(contents)
    } catch {
      // Why: a raw SyntaxError echoes credential bytes into logs/error UI; a
      // corrupt auth.json must fail loudly but without them (same sanitization
      // intent as the system-default identity path, which degrades instead).
      throw new Error('Codex auth.json is corrupt or not valid JSON')
    }
    // Why: API-key-based auth files have no OAuth tokens or JWT identity
    // claims. Returning nulls causes the caller to fail with a clear
    // "could not resolve the account email" error rather than crashing
    // on missing nested token fields.
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

  // Why: the system-default (activeAccountId:null) account has no stored
  // identity — its effective login is whatever the real ~/.codex/auth.json is
  // right now. Read it live and read-only so the switcher can display who the
  // system default is and attribute usage, without ever mutating ~/.codex.
  resolveSystemDefault(): CodexSystemDefaultIdentity {
    let contents: string
    try {
      // Why: a single read avoids an exists/read race and halves filesystem
      // probes whenever an accounts snapshot resolves this live identity.
      contents = readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf-8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // Why: no auth.json means either a signed-out home or an env-key/custom
        // provider that authenticates via OPENAI_API_KEY instead of a token file.
        return this.systemDefaultIdentity(false, this.hasEnvApiKey() ? 'api-key' : 'none')
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
      // Why: SyntaxError messages can echo malformed input; never let auth
      // contents or token fragments reach logs while degrading safely.
      console.warn('[codex-accounts] System-default Codex auth is not valid JSON')
      return this.systemDefaultIdentity(true, 'none')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // Why: valid JSON can still have the wrong shape; account listing must
      // degrade to an unknown identity instead of crashing the settings pane.
      console.warn('[codex-accounts] System-default Codex auth has an unexpected format')
      return this.systemDefaultIdentity(true, 'none')
    }
    if (declaresApiKeyCredential(parsed)) {
      // Why: API-key/custom-provider logins carry no OAuth identity or ChatGPT
      // usage. Surface them as a custom provider, not a blank/broken row.
      return this.systemDefaultIdentity(true, 'api-key')
    }

    const identity = readCodexAuthIdentity(contents)
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
