import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess, type ProcessResult } from '../../shared/child-process/run-process'
import { resolveCliCommand, withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'

export const PI_CODEX_AUTH_SOURCE_FILENAME = '.orca-pi-codex-auth.json'
const PI_AUTH_TIMEOUT_MS = 15_000
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth'
const OPENAI_PROFILE_CLAIM = 'https://api.openai.com/profile'

type JsonRecord = Record<string, unknown>

export type PiCodexAuthSource = {
  providerAccountId: string
}

export type PiCodexCredential = {
  accessToken: string
  providerAccountId: string
  email: string
}

type PiCodexAuthDependencies = {
  resolveCommand?: () => string
  run?: (args: Parameters<typeof runProcess>[0]) => Promise<ProcessResult>
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null
}

function stringClaim(value: JsonRecord | null, key: string): string | null {
  const claim = value?.[key]
  return typeof claim === 'string' && claim.trim() ? claim.trim() : null
}

function decodeJwtPayload(token: string): JsonRecord | null {
  const payload = token.split('.')[1]
  if (!payload) {
    return null
  }
  try {
    return record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

export function parsePiCodexBearerToken(accessToken: string): PiCodexCredential {
  const token = accessToken.trim()
  const payload = decodeJwtPayload(token)
  const auth = record(payload?.[OPENAI_AUTH_CLAIM])
  const profile = record(payload?.[OPENAI_PROFILE_CLAIM])
  const providerAccountId =
    stringClaim(auth, 'chatgpt_account_id') ?? stringClaim(payload, 'chatgpt_account_id')
  const email = stringClaim(payload, 'email') ?? stringClaim(profile, 'email')
  const expiresAt = payload?.exp
  if (typeof expiresAt === 'number' && expiresAt <= Date.now() / 1_000) {
    throw new Error('Pi returned an expired Codex credential. Sign in again in Pi.')
  }
  if (!token || !providerAccountId || !email) {
    throw new Error('Pi returned a Codex credential without account identity. Sign in again in Pi.')
  }
  return { accessToken: token, providerAccountId, email }
}

export async function getPiCodexCredential(
  signal?: AbortSignal,
  dependencies: PiCodexAuthDependencies = {}
): Promise<PiCodexCredential> {
  const command = (dependencies.resolveCommand ?? (() => resolveCliCommand('pi')))()
  let result: ProcessResult
  try {
    result = await (dependencies.run ?? runProcess)({
      program: command,
      args: ['auth', 'print-bearer-token', '--provider', 'openai-codex'],
      env: withCliRuntimeOnPath(command, { ...process.env }),
      timeoutMs: PI_AUTH_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      signal
    })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new Error(
      code === 'ENOENT'
        ? 'Pi CLI was not found. Install Pi and sign in to OpenAI Codex first.'
        : 'Pi could not provide the OpenAI Codex credential.',
      { cause: error }
    )
  }
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('Pi credential request aborted.')
  }
  if (result.timedOut) {
    throw new Error('Pi took too long to provide the OpenAI Codex credential.')
  }
  if (result.code !== 0) {
    throw new Error(
      'Pi has no usable OpenAI Codex login. Open Pi and run /login for ChatGPT Plus/Pro.'
    )
  }
  return parsePiCodexBearerToken(result.stdout)
}

export function createCodexAuthJsonFromPiCredential(credential: PiCodexCredential): string {
  return JSON.stringify(
    {
      auth_mode: 'chatgpt',
      tokens: {
        // Why: Orca's managed-account identity reader follows Codex's id_token
        // slot, while Pi exposes only a bearer token. OpenAI's access JWT carries
        // the same account/profile claims needed for local identity attribution.
        id_token: credential.accessToken,
        access_token: credential.accessToken,
        account_id: credential.providerAccountId
      },
      last_refresh: new Date().toISOString()
    },
    null,
    2
  )
}

export function serializePiCodexAuthSource(source: PiCodexAuthSource): string {
  return `${JSON.stringify(source)}\n`
}

export function hasPiCodexAuthSource(codexHomePath: string): boolean {
  return existsSync(join(codexHomePath, PI_CODEX_AUTH_SOURCE_FILENAME))
}

export function readPiCodexAuthSource(codexHomePath: string): PiCodexAuthSource | null {
  const markerPath = join(codexHomePath, PI_CODEX_AUTH_SOURCE_FILENAME)
  if (!existsSync(markerPath)) {
    return null
  }
  try {
    const parsed = record(JSON.parse(readFileSync(markerPath, 'utf8')))
    const providerAccountId = stringClaim(parsed, 'providerAccountId')
    return providerAccountId ? { providerAccountId } : null
  } catch {
    return null
  }
}
