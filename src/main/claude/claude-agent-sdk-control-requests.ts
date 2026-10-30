import type {
  PermissionMode,
  Query,
  SDKControlInterruptResponse
} from '@anthropic-ai/claude-agent-sdk'

export class ClaudeControlRequestError extends Error {
  constructor(
    readonly subtype: string,
    message: string
  ) {
    super(message)
    this.name = 'ClaudeControlRequestError'
  }
}

export const CLAUDE_DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** A timeout leaves the request outcome unknown; the CLI may still apply it. */
export class ClaudeControlRequestTimeoutError extends Error {
  constructor(readonly subtype: string) {
    super(`claude ${subtype} request timed out`)
    this.name = 'ClaudeControlRequestTimeoutError'
  }
}

// Exact SDK error used to distinguish query closure from CLI rejection.
const QUERY_CLOSED_MESSAGE = 'Query closed before response received'

// The SDK implements getSettings but omits it from Query's declaration.
type ClaudeQuerySettingsReader = { getSettings?: () => Promise<unknown> }

export function claudeQuerySettingsReader(query: Query): (() => Promise<unknown>) | null {
  const reader = (query as unknown as ClaudeQuerySettingsReader).getSettings
  return typeof reader === 'function' ? reader.bind(query) : null
}

// cancelAsyncMessage exists at runtime but is absent from Query's declaration.
type ClaudeQueryAsyncCanceller = { cancelAsyncMessage?: (uuid: string) => Promise<unknown> }

export function claudeQueryAsyncCanceller(
  query: Query
): ((uuid: string) => Promise<unknown>) | null {
  const cancel = (query as unknown as ClaudeQueryAsyncCanceller).cancelAsyncMessage
  return typeof cancel === 'function' ? cancel.bind(query) : null
}

export type ClaudeControlOptions = { timeoutMs?: number }

// Orca owns the deadline; null disables it. Query closure remains a transport failure.
export function runClaudeControl<T>(
  subtype: string,
  run: () => Promise<T>,
  timeoutMs: number | null = CLAUDE_DEFAULT_REQUEST_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const request = Promise.resolve()
    .then(run)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof ClaudeControlRequestError || message === QUERY_CLOSED_MESSAGE) {
        throw error
      }
      throw new ClaudeControlRequestError(subtype, message)
    })
  if (timeoutMs === null) {
    return request
  }
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ClaudeControlRequestTimeoutError(subtype)), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([request, deadline]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

export type ClaudeControlSurface = {
  interrupt: (
    options?: ClaudeControlOptions & { cancelQueued?: boolean }
  ) => Promise<SDKControlInterruptResponse | undefined>
  /** True only when the CLI confirms it withdrew that message before it ran. */
  cancelAsyncMessage: (uuid: string, options?: ClaudeControlOptions) => Promise<boolean>
  setModel: (model: string | undefined, options?: ClaudeControlOptions) => Promise<void>
  setPermissionMode: (mode: PermissionMode, options?: ClaudeControlOptions) => Promise<void>
  applyFlagSettings: (
    settings: Parameters<Query['applyFlagSettings']>[0],
    options?: ClaudeControlOptions
  ) => Promise<void>
  stopTask: (taskId: string, options?: ClaudeControlOptions) => Promise<void>
  supportedModels: (options?: ClaudeControlOptions) => Promise<unknown[]>
  /** Initialization is untimed; child exit closes the query. */
  initializationResult: () => Promise<unknown>
  getSettings: (options?: ClaudeControlOptions) => Promise<unknown>
  /** The `/context` breakdown; older CLIs reject the request and the caller shows nothing. */
  getContextUsage: (options?: ClaudeControlOptions) => Promise<unknown>
}

type InterruptingQuery = {
  interrupt: (options?: {
    cancelQueued?: boolean
  }) => Promise<SDKControlInterruptResponse | undefined>
}

export function createClaudeControlSurface(query: Query): ClaudeControlSurface {
  return {
    interrupt: (options) =>
      runClaudeControl(
        'interrupt',
        () =>
          (query as unknown as InterruptingQuery).interrupt(
            options?.cancelQueued ? { cancelQueued: true } : undefined
          ),
        options?.timeoutMs
      ),
    cancelAsyncMessage: (uuid, options) => {
      const cancel = claudeQueryAsyncCanceller(query)
      return cancel
        ? runClaudeControl('cancel_async_message', () => cancel(uuid), options?.timeoutMs).then(
            (cancelled) => cancelled === true
          )
        : Promise.resolve(false)
    },
    setModel: (model, options) =>
      runClaudeControl('set_model', () => query.setModel(model), options?.timeoutMs).then(() => {}),
    setPermissionMode: (mode, options) =>
      runClaudeControl(
        'set_permission_mode',
        () => query.setPermissionMode(mode),
        options?.timeoutMs
      ).then(() => {}),
    applyFlagSettings: (settings, options) =>
      runClaudeControl(
        'apply_flag_settings',
        () => query.applyFlagSettings(settings),
        options?.timeoutMs
      ).then(() => {}),
    stopTask: (taskId, options) =>
      runClaudeControl('stop_task', () => query.stopTask(taskId), options?.timeoutMs).then(
        () => {}
      ),
    supportedModels: (options) =>
      runClaudeControl('list_models', () => query.supportedModels(), options?.timeoutMs),
    initializationResult: () =>
      runClaudeControl('initialize', () => query.initializationResult(), null),
    getContextUsage: (options) =>
      runClaudeControl('get_context_usage', () => query.getContextUsage(), options?.timeoutMs),
    getSettings: (options) => {
      const read = claudeQuerySettingsReader(query)
      return read
        ? runClaudeControl('get_settings', read, options?.timeoutMs)
        : Promise.reject(
            new ClaudeControlRequestError(
              'get_settings',
              'this SDK exposes no get_settings request'
            )
          )
    }
  }
}
