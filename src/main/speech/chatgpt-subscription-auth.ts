import { join } from 'node:path'
import { z } from 'zod'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import type { CodexManagedAccount } from '../../shared/agent-accounts/managed-account-types'
import {
  getManagedAccountDisplayName,
  getManagedAccountInlineLabel
} from '../../shared/agent-accounts/managed-account-display-names'
import { isWslUncPath } from '../../shared/file-access/wsl-paths'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { ChatGptSpeechAccount, VoiceSettings } from '../../shared/speech/speech-types'
import { getSystemCodexHomePath } from '../codex/configuration/homes/codex-home-paths'
import { codexAuthMatchesManagedAccount } from '../codex-accounts/credentials/codex-auth-identity'
import { resolveHostCodexManagedHomeVerdictAsync } from '../codex-accounts/managed-homes/host-codex-managed-home-ownership'
import { createAuthFilesystemOperation } from '../rate-limits/providers/auth-filesystem-operation'
import { readCodexBackendAuthContents } from '../rate-limits/providers/codex/codex-backend-auth'

export type ChatGptSpeechSettings = Partial<
  Pick<GlobalSettings, 'codexManagedAccounts' | 'managedAccountDisplayNames'>
> & { voice?: VoiceSettings }

let readSettings: (() => ChatGptSpeechSettings) | null = null

export function setChatGptSpeechSettingsSource(source: (() => ChatGptSpeechSettings) | null): void {
  readSettings = source
}

function isHostAccount(account: CodexManagedAccount): boolean {
  return (
    account.managedHomeRuntime !== 'wsl' &&
    !account.wslDistro &&
    !account.wslLinuxHomePath &&
    !isWslUncPath(account.managedHomePath)
  )
}

export function listChatGptSpeechAccounts(settings: ChatGptSpeechSettings): ChatGptSpeechAccount[] {
  return (settings.codexManagedAccounts ?? []).filter(isHostAccount).map((account) => ({
    id: account.id,
    label: getManagedAccountInlineLabel({
      email: account.email,
      displayName: getManagedAccountDisplayName(
        settings.managedAccountDisplayNames,
        'codex',
        account.id
      )
    })
  }))
}

/** Capture identity, not credentials; auth stays in the account's existing managed home. */
export function captureChatGptSpeechAccount(): CodexManagedAccount | null {
  const settings = readSettings?.()
  const id = settings?.voice?.chatGptAccountId
  const account = id ? settings?.codexManagedAccounts?.find((entry) => entry.id === id) : undefined
  return account ? { ...account } : null
}

const codexAuthSchema = z.object({
  auth_mode: z.unknown().optional(),
  OPENAI_API_KEY: z.unknown().optional(),
  tokens: z.object({
    access_token: z.string(),
    id_token: z.string(),
    account_id: z.string().nullable().optional()
  })
})
const jwtHeaderSchema = z.object({
  alg: z
    .string()
    .min(1)
    .refine((value) => value.toLowerCase() !== 'none')
})
const jwtIdentitySchema = z.object({
  email: z.string().trim().min(1).optional(),
  'https://api.openai.com/profile': z
    .object({ email: z.string().trim().min(1).optional() })
    .optional(),
  'https://api.openai.com/auth': z
    .object({
      chatgpt_account_id: z.string().optional(),
      chatgpt_user_id: z.string().trim().min(1).optional(),
      user_id: z.string().trim().min(1).optional()
    })
    .optional()
})
const jwtPayloadSchema = jwtIdentitySchema.extend({
  exp: z.number().finite().positive()
})

function readJwtPayload(token: string): unknown {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Invalid token shape')
  }
  const parts = token.split('.')
  jwtHeaderSchema.parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')))
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
}

function authError(reason: string): Error {
  return new Error(
    `ChatGPT subscription login ${reason}. Choose a dictation account in Voice settings and sign in again through Accounts settings on this host. No paid API fallback was used.`
  )
}

function requireCurrentAccount(selection: CodexManagedAccount | null): CodexManagedAccount {
  const current = readSettings?.().codexManagedAccounts?.find((entry) => entry.id === selection?.id)
  if (!selection || !current) {
    throw authError('is unconfigured or the selected account was removed')
  }
  if (
    !isHostAccount(current) ||
    !/^[A-Za-z0-9_-]+$/.test(current.id) ||
    current.managedHomePath !== selection.managedHomePath ||
    current.email !== selection.email ||
    current.providerAccountId !== selection.providerAccountId ||
    current.workspaceAccountId !== selection.workspaceAccountId
  ) {
    throw authError('has an unavailable or changed account identity')
  }
  return current
}

export async function readChatGptSubscriptionHeaders(
  signal: AbortSignal,
  selection: CodexManagedAccount | null = captureChatGptSpeechAccount()
): Promise<Record<string, string>> {
  signal.throwIfAborted()
  const account = requireCurrentAccount(selection)
  let contents: string
  try {
    const verdict = await createAuthFilesystemOperation(account.managedHomePath, () =>
      resolveHostCodexManagedHomeVerdictAsync({
        candidatePath: account.managedHomePath,
        managedAccountsRoot: join(getAppEnvironment().getPath('userData'), 'codex-accounts'),
        systemCodexHomePath: getSystemCodexHomePath(),
        expectedAccountId: account.id
      })
    ).wait(signal)
    signal.throwIfAborted()
    if (verdict.kind !== 'owned' || isWslUncPath(verdict.homePath)) {
      throw new Error('Unowned managed home')
    }
    contents = await readCodexBackendAuthContents(join(verdict.homePath, 'auth.json'), signal)
  } catch {
    signal.throwIfAborted()
    throw authError('is missing, unreadable, or no longer owned by this Orca account')
  }
  signal.throwIfAborted()
  requireCurrentAccount(selection)
  let auth: z.infer<typeof codexAuthSchema>
  let payload: z.infer<typeof jwtPayloadSchema>
  let identity: z.infer<typeof jwtIdentitySchema>
  try {
    auth = codexAuthSchema.parse(JSON.parse(contents))
    if (
      (auth.auth_mode !== undefined &&
        auth.auth_mode !== 'chatgpt' &&
        auth.auth_mode !== 'chatgptAuthTokens') ||
      (auth.OPENAI_API_KEY !== undefined &&
        auth.OPENAI_API_KEY !== null &&
        auth.OPENAI_API_KEY !== '')
    ) {
      throw new Error('Not subscription OAuth')
    }
    payload = jwtPayloadSchema.parse(readJwtPayload(auth.tokens.access_token))
    identity = jwtIdentitySchema.parse(readJwtPayload(auth.tokens.id_token))
  } catch {
    throw authError('has invalid ChatGPT OAuth credentials (not an API key)')
  }
  if (payload.exp * 1000 <= Date.now()) {
    throw authError('has expired')
  }
  const accessClaims = payload['https://api.openai.com/auth']
  const identityClaims = identity['https://api.openai.com/auth']
  const claimId = accessClaims?.chatgpt_account_id
  const accountId = auth.tokens.account_id ?? claimId
  // OpenAI's user_id is the legacy alias; OAuth sub is not the ChatGPT user identifier.
  const accessUserId = accessClaims?.chatgpt_user_id ?? accessClaims?.user_id
  const identityUserId = identityClaims?.chatgpt_user_id ?? identityClaims?.user_id
  const identityEmail = identity.email ?? identity['https://api.openai.com/profile']?.email
  if (
    !accountId ||
    !/^[\x21-\x7e]{1,256}$/.test(accountId) ||
    (claimId !== undefined && claimId !== accountId) ||
    (identityClaims?.chatgpt_account_id !== undefined &&
      identityClaims.chatgpt_account_id !== accountId) ||
    !accessUserId ||
    accessUserId !== identityUserId ||
    !identityEmail ||
    identityEmail.toLowerCase() !== account.email?.trim().toLowerCase() ||
    !codexAuthMatchesManagedAccount(contents, account, null)
  ) {
    throw authError('has an invalid or changed account identity')
  }
  return {
    Authorization: `Bearer ${auth.tokens.access_token}`,
    'ChatGPT-Account-Id': accountId,
    originator: 'Codex Desktop',
    'User-Agent': `Orca/${getAppEnvironment().getVersion()} (${process.platform}; ${process.arch})`
  }
}

export async function hasChatGptSubscriptionAuth(): Promise<boolean> {
  try {
    await readChatGptSubscriptionHeaders(AbortSignal.timeout(5_000))
    return true
  } catch {
    return false
  }
}
