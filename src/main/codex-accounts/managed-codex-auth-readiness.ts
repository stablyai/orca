import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type { GlobalSettings } from '../../shared/types'
import type { CodexAccountSelectionTarget } from './runtime-selection'

const AUTH_READY_TIMEOUT_MS = 1_500
const AUTH_READY_RETRY_MS = 25

type StoredCodexAuth = {
  auth_mode?: unknown
  OPENAI_API_KEY?: unknown
  agent_identity?: unknown
  personal_access_token?: unknown
  bedrock_api_key?: unknown
  last_refresh?: unknown
  tokens?: unknown
}

const KNOWN_CREDENTIAL_KEYS = [
  'OPENAI_API_KEY',
  'tokens',
  'agent_identity',
  'personal_access_token',
  'bedrock_api_key'
] as const
const KNOWN_AGENT_IDENTITY_RECORD_KEYS = [
  'agent_runtime_id',
  'agent_private_key',
  'plan_type',
  'task_id'
] as const

export function waitForManagedCodexAuthReady(args: {
  codexHomePath: string | null
  settings: GlobalSettings | undefined
  target: CodexAccountSelectionTarget
}): Promise<boolean> | undefined {
  if (isCodexHomeAuthReadyForLaunch(args)) {
    return
  }
  return waitForStoredCodexCredential(join(args.codexHomePath!, 'auth.json'))
}

export function isCodexHomeAuthReadyForLaunch(args: {
  codexHomePath: string | null
  settings: GlobalSettings | undefined
  target: CodexAccountSelectionTarget
}): boolean {
  return (
    args.target.runtime !== 'host' ||
    !args.codexHomePath ||
    !isManagedHostCodexHome(args.codexHomePath, args.settings) ||
    hasStoredCodexCredential(join(args.codexHomePath, 'auth.json'))
  )
}

async function waitForStoredCodexCredential(authPath: string): Promise<boolean> {
  const deadline = Date.now() + AUTH_READY_TIMEOUT_MS
  do {
    await delay(AUTH_READY_RETRY_MS)
    if (hasStoredCodexCredential(authPath)) {
      return true
    }
  } while (Date.now() < deadline)

  console.warn(
    `[codex-auth-readiness] Managed credential remained unavailable after ${AUTH_READY_TIMEOUT_MS}ms`
  )
  return false
}

function isManagedHostCodexHome(
  codexHomePath: string,
  settings: GlobalSettings | undefined
): boolean {
  const expected = normalizeRuntimePathForComparison(codexHomePath)
  return (
    settings?.codexManagedAccounts?.some(
      (account) =>
        account.managedHomeRuntime !== 'wsl' &&
        normalizeRuntimePathForComparison(account.managedHomePath) === expected
    ) === true
  )
}

export type StoredCodexCredentialState =
  | 'present'
  | 'incomplete'
  | 'missing'
  | 'unreadable'
  | 'no-credential'

// Why: callers deciding whether to deselect an account must tell a settled
// logout ('no-credential') apart from a rotation in progress ('unreadable') or
// an absent file ('missing') — collapsing them to false logs users out on races.
export function readStoredCodexCredentialState(authPath: string): StoredCodexCredentialState {
  let raw: string
  try {
    raw = readFileSync(authPath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Why: Windows auth.json rotation can surface transient EPERM/EBUSY reads.
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable'
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Torn JSON means a write is in flight, not that the credential is gone.
    return 'unreadable'
  }
  if (!isRecord(parsed) || Object.keys(parsed).length === 0) {
    return 'no-credential'
  }
  const auth = parsed as StoredCodexAuth
  const hasCredential =
    auth.auth_mode == null
      ? hasCredentialWithoutDeclaredMode(auth)
      : hasCredentialForDeclaredMode(auth)
  if (hasCredential) {
    return 'present'
  }
  return hasIncompleteCredentialMaterial(auth) ? 'incomplete' : 'no-credential'
}

export function hasStoredCodexCredential(authPath: string): boolean {
  return readStoredCodexCredentialState(authPath) === 'present'
}

function hasCredentialForDeclaredMode(auth: StoredCodexAuth): boolean {
  if (!isNonEmptyString(auth.auth_mode)) {
    return false
  }
  switch (auth.auth_mode) {
    case 'apikey':
      return isNonEmptyString(auth.OPENAI_API_KEY)
    case 'chatgpt':
    case 'chatgptAuthTokens':
      return hasChatGptCredential(auth.tokens)
    case 'agentIdentity':
      return hasAgentIdentityCredential(auth.agent_identity)
    case 'personalAccessToken':
      return isNonEmptyString(auth.personal_access_token)
    case 'bedrockApiKey':
      return hasBedrockApiKey(auth.bedrock_api_key)
    default:
      return true
  }
}

function hasCredentialWithoutDeclaredMode(auth: StoredCodexAuth): boolean {
  const knownCredentialPresent = KNOWN_CREDENTIAL_KEYS.some((key) => key in auth)
  if (knownCredentialPresent) {
    return (
      isNonEmptyString(auth.OPENAI_API_KEY) ||
      hasChatGptCredential(auth.tokens) ||
      hasAgentIdentityCredential(auth.agent_identity) ||
      isNonEmptyString(auth.personal_access_token) ||
      hasBedrockApiKey(auth.bedrock_api_key)
    )
  }
  return Object.keys(auth).some((key) => key !== 'auth_mode' && key !== 'last_refresh')
}

function hasIncompleteCredentialMaterial(auth: StoredCodexAuth): boolean {
  return hasChatGptTokenMaterial(auth.tokens) || hasAgentIdentityMaterial(auth.agent_identity)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hasChatGptCredential(tokens: unknown): boolean {
  if (!isRecord(tokens)) {
    return false
  }
  return (
    isNonEmptyString(tokens.access_token) &&
    isNonEmptyString(tokens.id_token) &&
    isNonEmptyString(tokens.refresh_token)
  )
}

function hasAgentIdentityCredential(value: unknown): boolean {
  if (isNonEmptyString(value)) {
    return true
  }
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return false
  }
  return KNOWN_AGENT_IDENTITY_RECORD_KEYS.some((key) => key in value)
    ? isNonEmptyString(value.agent_runtime_id) && isNonEmptyString(value.agent_private_key)
    : true
}

function hasBedrockApiKey(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.api_key)
}

function hasChatGptTokenMaterial(tokens: unknown): boolean {
  return (
    isRecord(tokens) &&
    [tokens.access_token, tokens.id_token, tokens.refresh_token].some(isNonEmptyString)
  )
}

function hasAgentIdentityMaterial(value: unknown): boolean {
  return isNonEmptyString(value) || (isRecord(value) && Object.values(value).some(isNonEmptyString))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
