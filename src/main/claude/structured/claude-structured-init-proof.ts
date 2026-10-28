import type { AgentSessionAccountKind } from '../../../shared/agent-session-availability'
import { CLAUDE_DEFAULT_SETTING_SOURCES } from '../claude-structured-launch-resolution'
import type { ClaudeAuthDiagnostic, ClaudeSession } from './claude-structured-session-state'
import { AgentSessionAcquisitionRefusal } from '../../native-chat/agent-session-wire/structured-agent-session-adapter-errors'

export type ClaudeInitObservation = {
  providerSessionId: string
  uuid: string | null
  /** Only `system/init` reports the running model. */
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

/** Init and status frames describe the running mode; absent fields preserve the last report. */
export function readClaudeReportedPermissionMode(
  message: Record<string, unknown>
): string | null | undefined {
  if (
    message.type !== 'system' ||
    (message.subtype !== 'init' && message.subtype !== 'status') ||
    message.permissionMode === undefined
  ) {
    return undefined
  }
  switch (message.permissionMode) {
    case 'default':
      return 'ask'
    case 'acceptEdits':
      return 'accept-edits'
    case 'auto':
      return 'auto'
    case 'plan':
      return 'plan'
    case 'bypassPermissions':
      return 'full-access'
    case null:
    default:
      return null
  }
}

export function observeClaudeReportedPermissionMode(
  reports: ClaudeSession['reportedOptions'],
  message: Record<string, unknown>
): boolean {
  const mode = readClaudeReportedPermissionMode(message)
  if (mode === undefined || mode === reports.reportedPermissionMode) {
    return false
  }
  reports.reportedPermissionMode = mode
  return true
}

export function readClaudeModels(initialization: unknown): unknown[] {
  return isRecord(initialization) && Array.isArray(initialization.models)
    ? initialization.models
    : []
}

/** Empty reports do not retract capabilities: SessionStart and older initialize replies omit them. */
export function readClaudeCapabilities(
  observed: readonly string[],
  ...reports: unknown[]
): readonly string[] {
  for (const report of reports) {
    const advertised = isRecord(report) ? report.capabilities : undefined
    const capabilities = Array.isArray(advertised)
      ? advertised.filter((value): value is string => typeof value === 'string')
      : []
    if (capabilities.length > 0) {
      return capabilities
    }
  }
  return observed
}

export function claudeInitializationAuthError(
  initialization: unknown,
  accountKind?: AgentSessionAccountKind
): AgentSessionAcquisitionRefusal | null {
  const account =
    isRecord(initialization) && isRecord(initialization.account) ? initialization.account : {}
  // An API key (ANTHROPIC_API_KEY or a Console /login key) reports tokenSource "none".
  const apiKeySource = readClaudeFrameString(account, 'apiKeySource')
  return readClaudeFrameString(account, 'tokenSource') === 'none' &&
    (apiKeySource === null || apiKeySource === 'none')
    ? new AgentSessionAcquisitionRefusal(
        'Claude is not signed in for the selected account. Sign in with the Claude CLI for this CLAUDE_CONFIG_DIR, then retry.',
        'notSignedIn',
        accountKind
      )
    : null
}

export function claudeAuthDiagnostic(
  initialization: unknown,
  init: ClaudeInitObservation | null,
  settings: unknown
): ClaudeAuthDiagnostic {
  const env = isRecord(settings) && isRecord(settings.env) ? settings.env : {}
  const account =
    isRecord(initialization) && isRecord(initialization.account) ? initialization.account : {}
  const apiKeySource =
    readClaudeFrameString(account, 'apiKeySource') ??
    (init ? readClaudeFrameString(init.message, 'apiKeySource') : null)
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

/** Startup uses any session proof already observed; it cannot wait for the first turn's init. */
export type ClaudeInitProof = {
  promise: Promise<ClaudeInitObservation>
  resolve: (init: ClaudeInitObservation) => void
  reject: (error: Error) => void
  refuse: () => void
  /** The proof seen so far, or null; throws when it was refused or the child failed first. */
  seen: () => ClaudeInitObservation | null
  /** Refusals after startup must end the published session. */
  onRefusal: ((error: Error) => void) | null
}

export function createClaudeInitProof(): ClaudeInitProof {
  let resolvePromise = (_init: ClaudeInitObservation): void => {}
  let rejectPromise = (_error: Error): void => {}
  const promise = new Promise<ClaudeInitObservation>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  void promise.catch(() => {})
  let outcome: { init: ClaudeInitObservation } | { error: Error } | null = null
  const reject = (error: Error): void => {
    outcome ??= { error }
    rejectPromise(error)
  }
  const proof: ClaudeInitProof = {
    promise,
    resolve: (init) => {
      outcome ??= { init }
      resolvePromise(init)
    },
    reject,
    refuse: () => {
      if (outcome && 'init' in outcome) {
        return
      }
      const error = new Error('claude provider session expected')
      reject(error)
      proof.onRefusal?.(error)
    },
    seen: () => {
      if (outcome && 'error' in outcome) {
        throw outcome.error
      }
      return outcome?.init ?? null
    },
    onRefusal: null
  }
  return proof
}
