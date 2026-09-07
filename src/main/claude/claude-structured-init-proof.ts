import { CLAUDE_DEFAULT_SETTING_SOURCES } from './claude-structured-launch-resolution'
import type { ClaudeAuthDiagnostic } from './claude-structured-session-state'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export type ClaudeInitObservation = {
  providerSessionId: string
  uuid: string | null
  /** The resolved model id the CLI reports it is running; only `system/init` carries it. */
  model: string | null
  message: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readClaudeFrameString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function readClaudeInit(message: Record<string, unknown>): ClaudeInitObservation | null {
  const hookName = readClaudeFrameString(message, 'hook_name')
  const isInit = message.type === 'system' && message.subtype === 'init'
  const isSessionStart =
    message.type === 'system' &&
    (message.subtype === 'hook_started' || message.subtype === 'hook_response') &&
    hookName?.startsWith('SessionStart:') === true
  if (!isInit && !isSessionStart) {
    return null
  }
  const providerSessionId = readClaudeFrameString(message, 'session_id')
  return providerSessionId
    ? {
        providerSessionId,
        uuid: isInit ? readClaudeFrameString(message, 'uuid') : null,
        model: isInit ? readClaudeFrameString(message, 'model') : null,
        message
      }
    : null
}

export function readClaudeModels(initialization: unknown): unknown[] {
  return isRecord(initialization) && Array.isArray(initialization.models)
    ? initialization.models
    : []
}

/** CLI capabilities advertised on the initialize result or the yielded system/init frame. */
export function readClaudeCapabilities(
  init: ClaudeInitObservation,
  initialization: unknown
): string[] {
  const fromResult = isRecord(initialization) ? initialization.capabilities : undefined
  const fromFrame = init.message.capabilities
  const source = Array.isArray(fromResult) ? fromResult : Array.isArray(fromFrame) ? fromFrame : []
  return source.filter((value): value is string => typeof value === 'string')
}

export function claudeInitializationAuthError(
  initialization: unknown
): AgentSessionAcquisitionRefusal | null {
  const account =
    isRecord(initialization) && isRecord(initialization.account) ? initialization.account : null
  return readClaudeFrameString(account ?? {}, 'tokenSource') === 'none'
    ? new AgentSessionAcquisitionRefusal(
        'Claude is not signed in for the selected account. Sign in with the Claude CLI for this CLAUDE_CONFIG_DIR, then retry.'
      )
    : null
}

export function claudeAuthDiagnostic(
  init: ClaudeInitObservation,
  settings: unknown
): ClaudeAuthDiagnostic {
  const env = isRecord(settings) && isRecord(settings.env) ? settings.env : {}
  const apiKeySource = readClaudeFrameString(init.message, 'apiKeySource')
  const configured = (key: string): boolean =>
    (typeof env[key] === 'string' && (env[key] as string).trim().length > 0) ||
    Boolean(process.env[key]?.trim())
  return {
    apiKeySourceConfigured: apiKeySource !== null && apiKeySource !== 'none',
    baseUrlConfigured: configured('ANTHROPIC_BASE_URL'),
    authTokenConfigured: configured('ANTHROPIC_AUTH_TOKEN'),
    apiKeyConfigured: configured('ANTHROPIC_API_KEY'),
    settingSources: CLAUDE_DEFAULT_SETTING_SOURCES
  }
}
