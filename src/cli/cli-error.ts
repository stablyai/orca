import { computerUseErrorRecoveryData } from '../shared/computer-use-error-recovery'
import {
  matchAutomationOwnerConflict,
  stripAutomationOwnerConflictCode
} from '../shared/automation-owner-conflict'
import { automationOwnerConflictRecovery } from './automation-owner-conflict-recovery'
import { worktreeSelectorRecovery } from './worktree-selector-recovery'
import { selectorAmbiguityRecovery } from './selector-ambiguity-recovery'
import type { RuntimeRpcFailure } from './runtime-client'
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime/types'

export type CliErrorContext = {
  commandPath?: readonly string[]
  /** The `--worktree` value this invocation sent; the runtime's error never echoes it. */
  worktreeSelector?: string
  /** The runtime error omits the original --repo selector. */
  repoSelector?: string
  /** True when --environment, --pairing-code, --host runtime:, or their env vars chose a server. */
  remoteServerSelected?: boolean
}

type ContextRecovery = { nextSteps: readonly string[] } & Record<string, unknown>

const STALE_HANDLE_SERVER_HINT =
  'Terminal handles belong to the Orca server that issued them. If this handle came from a paired server (for example `orca terminal list --environment <server>`), pass the same --environment <server> to this command.'

function contextRecovery(
  code: string | undefined,
  context: CliErrorContext
): ContextRecovery | undefined {
  if (code === 'selector_not_found' && context.worktreeSelector) {
    return worktreeSelectorRecovery(context.worktreeSelector)
  }
  if (code === 'selector_ambiguous') {
    return selectorAmbiguityRecovery({
      repo: context.repoSelector,
      worktree: context.worktreeSelector,
      remoteServerSelected: context.remoteServerSelected
    })
  }
  // A remote handle sent locally looks stale rather than missing a flag.
  if (
    code === 'terminal_handle_stale' &&
    context.commandPath?.[0] === 'terminal' &&
    context.remoteServerSelected === false
  ) {
    return { nextSteps: [STALE_HANDLE_SERVER_HINT] }
  }
  return undefined
}

function errorData(error: unknown): unknown {
  if (error instanceof RuntimeRpcFailureError) {
    return error.response.error.data
  }
  return error instanceof RuntimeClientError ? error.data : undefined
}

export function cliErrorCode(error: unknown): string | undefined {
  if (error instanceof RuntimeRpcFailureError) {
    return error.response.error.code
  }
  return error instanceof RuntimeClientError ? error.code : undefined
}

export function formatCliError(error: unknown, context: CliErrorContext = {}): string {
  const message = error instanceof Error ? error.message : String(error)
  const selector = contextRecovery(cliErrorCode(error), context)
  if (selector) {
    return formatMessageWithNextSteps(
      message,
      nextStepsFromData(mergeContextRecovery(errorData(error), selector))
    )
  }
  if (error instanceof RuntimeClientError && error.code === 'runtime_unavailable') {
    if (hasOrchestrationRequestId(error.data)) {
      return message
    }
    return formatRuntimeUnavailableError(message, error.data)
  }
  // Match before generic recovery; flattened errors may retain only the conflict token.
  const conflict = automationOwnerConflictRecovery(matchAutomationOwnerConflict(error))
  if (conflict) {
    return formatMessageWithNextSteps(stripAutomationOwnerConflictCode(message), conflict.nextSteps)
  }
  const sidecarExit = computerSidecarExitRecovery(error, context)
  if (sidecarExit) {
    return formatMessageWithNextSteps(message, sidecarExit.nextSteps)
  }
  if (error instanceof RuntimeClientError) {
    const nextSteps = nextStepsFromData(error.data)
    if (nextSteps.length > 0) {
      return formatMessageWithNextSteps(message, nextSteps)
    }
    if (error.code === 'invalid_argument' && context.commandPath?.[0] === 'computer') {
      return formatMessageWithNextSteps(
        message,
        computerUseErrorRecoveryData('invalid_argument')?.nextSteps ?? []
      )
    }
  }
  if (
    error instanceof RuntimeRpcFailureError &&
    error.response.error.code === 'runtime_unavailable'
  ) {
    return formatRuntimeUnavailableError(message, error.response.error.data)
  }
  if (error instanceof RuntimeRpcFailureError) {
    return formatMessageWithNextSteps(message, nextStepsFromData(error.response.error.data))
  }
  return message
}

function hasOrchestrationRequestId(data: unknown): boolean {
  return (
    data !== null &&
    typeof data === 'object' &&
    typeof (data as { orchestrationRequestId?: unknown }).orchestrationRequestId === 'string'
  )
}

function formatRuntimeUnavailableError(message: string, data: unknown): string {
  const nextSteps = nextStepsFromData(data)
  if (nextSteps.length > 0) {
    return formatMessageWithNextSteps(message, nextSteps)
  }
  return `${message}\nOrca is not running. Run 'orca open' first.`
}

export function reportCliError(error: unknown, json: boolean, context: CliErrorContext = {}): void {
  const selector = contextRecovery(cliErrorCode(error), context)
  if (json) {
    if (error instanceof RuntimeRpcFailureError) {
      const sidecarExit = computerSidecarExitRecovery(error, context)
      const response = sidecarExit
        ? { ...error.response, error: { ...error.response.error, data: sidecarExit } }
        : withAutomationOwnerConflictRecovery(error.response)
      console.log(
        JSON.stringify(
          selector
            ? {
                ...response,
                error: {
                  ...response.error,
                  data: mergeContextRecovery(response.error.data, selector)
                }
              }
            : response,
          null,
          2
        )
      )
    } else {
      const response: RuntimeRpcFailure = {
        id: 'local',
        ok: false,
        error: {
          code:
            matchAutomationOwnerConflict(error) ??
            (error instanceof RuntimeClientError ? error.code : 'runtime_error'),
          message: stripAutomationOwnerConflictCode(
            error instanceof Error ? error.message : String(error)
          ),
          data: localCliErrorData(error, context)
        },
        _meta: {
          runtimeId: null
        }
      }
      console.log(JSON.stringify(response, null, 2))
    }
  } else {
    console.error(formatCliError(error, context))
  }
}

function withAutomationOwnerConflictRecovery(response: RuntimeRpcFailure): RuntimeRpcFailure {
  const code = matchAutomationOwnerConflict(response)
  const conflict = automationOwnerConflictRecovery(code)
  if (!conflict || !code) {
    return response
  }
  return {
    ...response,
    error: {
      ...response.error,
      // Restore conflict classification lost during transport flattening.
      code,
      message: stripAutomationOwnerConflictCode(response.error.message),
      data: response.error.data ?? conflict
    }
  }
}

function formatMessageWithNextSteps(message: string, nextSteps: readonly string[]): string {
  if (nextSteps.length === 0) {
    return message
  }
  return `${message}\n${nextSteps.map((step) => `Next step: ${step}`).join('\n')}`
}

// Preserve both mutation request IDs and selector recovery hints.
function mergeContextRecovery(
  data: unknown,
  selector: ReturnType<typeof contextRecovery>
): unknown {
  if (!selector) {
    return data
  }
  if (
    data &&
    typeof data === 'object' &&
    'validSelectorForms' in data &&
    'nextSteps' in data &&
    Array.isArray(data.validSelectorForms) &&
    data.validSelectorForms.every((form: unknown) => typeof form === 'string') &&
    Array.isArray(data.nextSteps) &&
    data.nextSteps.every((step: unknown) => typeof step === 'string')
  ) {
    return data
  }
  if (data === null || typeof data !== 'object') {
    return selector
  }
  return {
    ...selector,
    ...data,
    nextSteps: [...selector.nextSteps, ...nextStepsFromData(data)]
  }
}

function nextStepsFromData(data: unknown): string[] {
  if (
    data &&
    typeof data === 'object' &&
    Array.isArray((data as { nextSteps?: unknown }).nextSteps)
  ) {
    return (data as { nextSteps: unknown[] }).nextSteps.filter(
      (step): step is string => typeof step === 'string'
    )
  }
  return []
}

// Older servers do not include this recovery hint in error data.
function computerSidecarExitRecovery(error: unknown, context: CliErrorContext) {
  if (
    context.commandPath?.[0] !== 'computer' ||
    cliErrorCode(error) !== 'accessibility_error' ||
    !(error instanceof Error) ||
    !error.message.startsWith('computer sidecar exited with code')
  ) {
    return undefined
  }
  return computerUseErrorRecoveryData('accessibility_error', error.message)
}

function localCliErrorData(error: unknown, context: CliErrorContext): unknown {
  const sidecarExit = computerSidecarExitRecovery(error, context)
  if (sidecarExit) {
    return sidecarExit
  }
  const selector = contextRecovery(cliErrorCode(error), context)
  // Error-specific recovery takes precedence over the generic fallback.
  if (error instanceof RuntimeClientError && error.data !== undefined) {
    return mergeContextRecovery(error.data, selector)
  }
  if (selector) {
    return selector
  }
  const conflict = automationOwnerConflictRecovery(matchAutomationOwnerConflict(error))
  if (conflict) {
    return conflict
  }
  if (
    error instanceof RuntimeClientError &&
    error.code === 'invalid_argument' &&
    context.commandPath?.[0] === 'computer'
  ) {
    return computerUseErrorRecoveryData('invalid_argument')
  }
  return undefined
}
