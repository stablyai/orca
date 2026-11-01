import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { CLAUDE_API_ENDPOINT_FILE } from '../../shared/claude-profile-routing'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import type {
  ClaudeApiEndpointAccountRequest,
  ClaudeApiEndpointSummary
} from '../../shared/managed-account-types'
import { writeSecureFile } from '../../shared/secure-file'

export { CLAUDE_API_ENDPOINT_FILE }

const endpointFile = z.object({
  baseUrl: z.string().min(1),
  authToken: z.string().min(1),
  model: z.string().min(1),
  smallFastModel: z.string().min(1)
})

type ClaudeApiEndpointFile = z.infer<typeof endpointFile>

/** A blank token keeps `savedToken`, so editing an account need not show its token again. */
export function normalizeClaudeApiEndpointRequest(
  request: ClaudeApiEndpointAccountRequest,
  savedToken: string | null = null
): ClaudeApiEndpointAccountRequest {
  const label = request.label.trim()
  const authToken = request.authToken.trim() || savedToken || ''
  const model = request.model.trim()
  const smallFastModel = request.smallFastModel.trim() || model
  let url: URL
  try {
    url = new URL(request.baseUrl.trim())
  } catch {
    throw new Error('Enter the endpoint as a full URL, such as https://api.example.com.')
  }
  // Plain HTTP would send the token in the clear; allow it only for a local gateway.
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('The endpoint must use https.')
  }
  if (!label || !authToken || !model) {
    throw new Error('Enter a name, a token, and a model.')
  }
  return {
    label,
    authToken,
    model,
    smallFastModel,
    baseUrl: url.toString().replace(/\/+$/, '')
  }
}

export function writeClaudeApiEndpoint(
  home: string,
  endpoint: ClaudeApiEndpointAccountRequest
): ClaudeApiEndpointSummary {
  const file: ClaudeApiEndpointFile = {
    baseUrl: endpoint.baseUrl,
    authToken: endpoint.authToken,
    model: endpoint.model,
    smallFastModel: endpoint.smallFastModel
  }
  writeSecureFile(join(home, CLAUDE_API_ENDPOINT_FILE), `${JSON.stringify(file, null, 2)}\n`)
  return {
    baseUrl: file.baseUrl,
    model: file.model,
    smallFastModel: file.smallFastModel
  }
}

function readClaudeApiEndpointFile(home: string): ClaudeApiEndpointFile | null {
  let raw: string
  try {
    raw = readFileSync(join(home, CLAUDE_API_ENDPOINT_FILE), 'utf8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
  return endpointFile.parse(JSON.parse(raw))
}

export function readClaudeApiEndpointToken(home: string): string | null {
  return readClaudeApiEndpointFile(home)?.authToken ?? null
}

/** The env Claude Code applies from settings.json; null when the folder holds no endpoint. */
export function readClaudeApiEndpointEnv(home: string): Record<string, string> | null {
  const file = readClaudeApiEndpointFile(home)
  if (!file) {
    return null
  }
  return {
    ANTHROPIC_BASE_URL: file.baseUrl,
    ANTHROPIC_AUTH_TOKEN: file.authToken,
    ANTHROPIC_MODEL: file.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: file.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: file.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: file.smallFastModel,
    // Older Claude Code versions read this name for background tasks.
    ANTHROPIC_SMALL_FAST_MODEL: file.smallFastModel
  }
}
