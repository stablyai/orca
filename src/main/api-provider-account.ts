import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import {
  ApiProviderAccountSchema,
  type ApiProviderAccount,
  type AddApiProviderAccount
} from '../shared/api-provider-account'
import { writeSecureFile } from '../shared/secure-file'
import { isDefinitiveAbsence } from '../shared/definitive-filesystem-absence'

export const API_PROVIDER_ACCOUNT_FILE = 'orca-api-provider.json'
const CLAUDE_API_ROUTING_ENV = {
  CLAUDE_CODE_OAUTH_TOKEN: '',
  CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '',
  CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '',
  CLAUDE_CODE_USE_BEDROCK: '',
  CLAUDE_CODE_USE_VERTEX: '',
  CLAUDE_CODE_USE_FOUNDRY: '',
  CLAUDE_CODE_USE_GATEWAY: '',
  ANTHROPIC_UNIX_SOCKET: '',
  ANTHROPIC_CUSTOM_HEADERS: ''
} as const
const CLAUDE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL'
] as const

export function readApiProviderAccount(home: string): ApiProviderAccount | null {
  let contents: string
  try {
    contents = readFileSync(join(home, API_PROVIDER_ACCOUNT_FILE), 'utf8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw new Error('The API account configuration could not be read.')
  }
  try {
    return ApiProviderAccountSchema.parse(JSON.parse(contents))
  } catch {
    throw new Error('The API account configuration is invalid. Remove and add this account again.')
  }
}

export function saveApiProviderAccount(
  home: string,
  input: AddApiProviderAccount,
  agent: 'claude' | 'codex'
): ApiProviderAccount {
  const metadata = ApiProviderAccountSchema.parse(input)
  if (agent === 'codex') {
    writeApiAccountFile(
      join(home, 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: input.apiKey })
    )
  } else {
    const path = join(home, 'settings.json')
    let settings: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!isRecord(parsed)) {
        throw new Error('Expected settings object')
      }
      settings = parsed
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        throw new Error(
          'Claude settings could not be read safely. Repair them before adding an API account.'
        )
      }
    }
    const env = claudeApiProviderEnv(settings)
    settings.env = {
      ...env,
      ...CLAUDE_API_ROUTING_ENV,
      ANTHROPIC_BASE_URL: metadata.baseUrl,
      ANTHROPIC_AUTH_TOKEN: input.apiKey,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: metadata.model
    }
    writeApiAccountFile(path, `${JSON.stringify(settings, null, 2)}\n`)
  }
  writeApiAccountFile(
    join(home, API_PROVIDER_ACCOUNT_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`
  )
  return metadata
}

function claudeApiProviderEnv(settings: Record<string, unknown>): Record<string, unknown> {
  const env = settings.env
  return typeof env === 'object' && env !== null && !Array.isArray(env)
    ? Object.fromEntries(Object.entries(env))
    : {}
}

export function preserveClaudeApiProviderSettings(
  home: string,
  source: Record<string, unknown>,
  current: Record<string, unknown>
): Record<string, unknown> {
  const provider = readApiProviderAccount(home)
  if (!provider) {
    return source
  }
  const env = requireClaudeApiProviderEnv(current, provider)
  return {
    ...source,
    env: {
      ...claudeApiProviderEnv(source),
      ...CLAUDE_API_ROUTING_ENV,
      ...Object.fromEntries(CLAUDE_ENV_KEYS.map((key) => [key, env[key]]))
    }
  }
}

export function applyCodexApiProviderConfig(home: string, provider: ApiProviderAccount): void {
  const path = join(home, 'config.toml')
  const config = existsSync(path) ? parse(readFileSync(path, 'utf8')) : {}
  const providers = config.model_providers
  config.model = provider.model
  config.model_provider = 'orca_api_account'
  config.service_tier = 'default'
  config.model_providers = {
    ...(typeof providers === 'object' &&
    providers !== null &&
    !Array.isArray(providers) &&
    !(providers instanceof Date)
      ? providers
      : {}),
    orca_api_account: {
      name: provider.label,
      base_url: provider.baseUrl,
      wire_api: 'responses',
      requires_openai_auth: true,
      supports_websockets: false
    }
  }
  writeApiAccountFile(path, stringify(config))
}

export function assertApiProviderAccountHome(
  home: string | null,
  expected?: ApiProviderAccount,
  agent?: 'claude' | 'codex'
): void {
  if (!home || !expected) {
    return
  }
  const actual = readApiProviderAccount(home)
  if (
    !actual ||
    actual.label !== expected.label ||
    actual.baseUrl !== expected.baseUrl ||
    actual.model !== expected.model
  ) {
    throw new Error(
      'The API account configuration is missing or changed. Remove and add this account again.'
    )
  }
  if (agent) {
    const path = join(home, agent === 'claude' ? 'settings.json' : 'auth.json')
    let credentials: unknown
    try {
      if (!lstatSync(path).isFile()) {
        throw new Error('Expected a private credential file')
      }
      credentials = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      throw new Error(
        'The API account key is missing or unreadable. Remove and add this account again.'
      )
    }
    if (!isRecord(credentials)) {
      throw new Error('The API account credentials are invalid. Remove and add this account again.')
    }
    if (agent === 'claude') {
      requireClaudeApiProviderEnv(credentials, expected)
    } else if (
      typeof credentials.OPENAI_API_KEY !== 'string' ||
      !credentials.OPENAI_API_KEY.trim()
    ) {
      throw new Error('The API account key is missing. Remove and add this account again.')
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireClaudeApiProviderEnv(
  settings: Record<string, unknown>,
  provider: ApiProviderAccount
): Record<string, unknown> {
  const env = claudeApiProviderEnv(settings)
  if (typeof env.ANTHROPIC_AUTH_TOKEN !== 'string' || !env.ANTHROPIC_AUTH_TOKEN.trim()) {
    throw new Error('The API account key is missing. Remove and add this API account again.')
  }
  if (
    env.ANTHROPIC_BASE_URL !== provider.baseUrl ||
    env.ANTHROPIC_MODEL !== provider.model ||
    Object.entries(CLAUDE_API_ROUTING_ENV).some(([key, value]) => env[key] !== value)
  ) {
    throw new Error('The API account provider settings changed. Remove and add this account again.')
  }
  return env
}

export function writeApiAccountFile(
  path: string,
  contents: string,
  shouldPublish?: () => boolean
): void {
  if (!writeSecureFile(path, contents, { durable: true, shouldPublish })) {
    throw new Error('The API account file could not be saved with private permissions.')
  }
}

export function apiProviderUsageNotice(home: string | null): { usageError?: string } {
  return home && readApiProviderAccount(home)
    ? { usageError: 'API key billing — check usage with your API provider.' }
    : {}
}
