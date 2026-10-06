// Canonical CLI state can change independently of the account catalog after /login.
import { z } from 'zod'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import type { ProfileIdentity } from '../../shared/agent-launch-profile'
import { AgentProfilePreparationError } from '../agent-profiles/preparation-error'
import { resolveClaudeIdentity } from './claude-auth-capture'
import { hasIsolatedClaudeAccountAuth, readClaudeAccountCredentials } from './isolated-account-auth'
import { readClaudeManagedAuthFile } from './managed-auth-path'

const credentialsSchema = z
  .object({
    claudeAiOauth: z.object({ accessToken: z.string().trim().min(1) }).passthrough()
  })
  .passthrough()
const configSchema = z.object({ oauthAccount: z.unknown() })
const accountSchema = z.object({ accountUuid: z.string().optional() }).passthrough()

export async function readManagedClaudeProfileIdentity(
  account: ClaudeManagedAccount
): Promise<ProfileIdentity> {
  if (account.authMethod !== 'subscription-oauth' || !account.email.trim()) {
    return { kind: 'unverified', reason: 'Managed Claude identity is unknown.' }
  }
  try {
    const home = account.managedAuthPath
    const credentials = await readClaudeAccountCredentials({
      accountId: account.id,
      managedAuthPath: home
    })
    const credential = credentialsSchema.parse(JSON.parse(credentials ?? 'null'))
    const isolated = hasIsolatedClaudeAccountAuth(home)
    const metadata: unknown = JSON.parse(
      readClaudeManagedAuthFile(home, isolated ? '.claude.json' : 'oauth-account.json') ?? 'null'
    )
    const oauth = accountSchema.parse(
      isolated ? configSchema.parse(metadata).oauthAccount : metadata
    )
    const canonical = resolveClaudeIdentity('', oauth, '{}')
    const token = resolveClaudeIdentity('', credential.claudeAiOauth, '{}')
    const expectedOrg = account.organizationUuid ?? account.organizationName ?? null
    const canonicalOrg = canonical.organizationUuid ?? canonical.organizationName
    const tokenAccount = accountSchema.parse(credential.claudeAiOauth)
    if (
      canonical.email !== account.email ||
      (expectedOrg !== null && expectedOrg !== canonicalOrg) ||
      (tokenAccount.accountUuid !== undefined && tokenAccount.accountUuid !== oauth.accountUuid) ||
      (token.email !== null && token.email !== canonical.email) ||
      (token.organizationUuid !== null && token.organizationUuid !== canonical.organizationUuid)
    ) {
      throw new Error('identity mismatch')
    }
    // Enrollment metadata is an identity witness, never a source for restoring rotated tokens.
    const enrolled = readClaudeManagedAuthFile(home, 'oauth-account.json')
    if (isolated && enrolled) {
      const original = accountSchema.parse(JSON.parse(enrolled))
      if (original.accountUuid && original.accountUuid !== oauth.accountUuid) {
        throw new Error('account changed')
      }
    }
    return {
      kind: 'verified',
      subject: JSON.stringify(['claude', canonical.email, canonicalOrg]),
      displayName: canonical.email
    }
  } catch {
    throw new AgentProfilePreparationError('claude_identity')
  }
}
