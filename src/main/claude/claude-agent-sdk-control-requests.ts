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

/** The deadline fired before the CLI answered. The request may still land, so this proves
 *  nothing about it either way; it is neither the CLI refusing nor the transport closing. */
export class ClaudeControlRequestTimeoutError extends Error {
  constructor(readonly subtype: string) {
    super(`claude ${subtype} request timed out`)
    this.name = 'ClaudeControlRequestTimeoutError'
  }
}

/** The SDK closes a query out from under an in-flight control request with this exact message. */
const QUERY_CLOSED_MESSAGE = 'Query closed before response received'

/** 0.3.251 ships getSettings() but redacts it from the Query declaration; the typeof guard below is its degradation path. */
type ClaudeQuerySettingsReader = { getSettings?: () => Promise<unknown> }

export function claudeQuerySettingsReader(query: Query): (() => Promise<unknown>) | null {
  const reader = (query as unknown as ClaudeQuerySettingsReader).getSettings
  return typeof reader === 'function' ? reader.bind(query) : null
}

/**
 * cancel_async_message is a runtime Query method the shipped 0.3.251 declaration omits;
 * it withdraws a single still-queued async user message by uuid so an interrupted turn
 * cannot spawn a later unexpected turn. The typeof guard is its degradation path.
 */
type ClaudeQueryAsyncCanceller = { cancelAsyncMessage?: (uuid: string) => Promise<unknown> }

export function claudeQueryAsyncCanceller(
  query: Query
): ((uuid: string) => Promise<unknown>) | null {
  const cancel = (query as unknown as ClaudeQueryAsyncCanceller).cancelAsyncMessage
  return typeof cancel === 'function' ? cancel.bind(query) : null
}

export type ClaudeControlOptions = { timeoutMs?: number }

/**
 * Run one native Query control method under Orca's deadline and error classification.
 *
 * The SDK owns correlation but applies no deadline, so the timeout stays here. `null` means
 * none: the request then settles only on the CLI's answer or on the query closing under it.
 * A closed query is a transport failure, not the CLI rejecting the request, so only the
 * latter is re-thrown as a `ClaudeControlRequestError` a caller may surface as a rejection.
 */
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

/** The native control surface Orca drives, one method per Query control request. */
export type ClaudeControlSurface = {
  interrupt: (
    options?: ClaudeControlOptions & { cancelQueued?: boolean }
  ) => Promise<SDKControlInterruptResponse | undefined>
  cancelAsyncMessage: (uuid: string, options?: ClaudeControlOptions) => Promise<void>
  setModel: (model: string | undefined, options?: ClaudeControlOptions) => Promise<void>
  setPermissionMode: (mode: PermissionMode, options?: ClaudeControlOptions) => Promise<void>
  applyFlagSettings: (
    settings: Parameters<Query['applyFlagSettings']>[0],
    options?: ClaudeControlOptions
  ) => Promise<void>
  stopTask: (taskId: string, options?: ClaudeControlOptions) => Promise<void>
  supportedModels: (options?: ClaudeControlOptions) => Promise<unknown[]>
  /** Untimed: a slow start is still a start, and the child's exit closes the query under it. */
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
            () => {}
          )
        : Promise.resolve()
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
