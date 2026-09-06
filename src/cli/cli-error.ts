import { computerUseErrorRecoveryData } from '../shared/computer-use-error-recovery'
import {
  matchAutomationOwnerConflict,
  stripAutomationOwnerConflictCode
} from '../shared/automation-owner-conflict'
import { automationOwnerConflictRecovery } from './automation-owner-conflict-recovery'
import type { RuntimeRpcFailure } from './runtime-client'
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime/types'

type CliErrorContext = {
  commandPath?: readonly string[]
}

export function formatCliError(error: unknown, context: CliErrorContext = {}): string {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof RuntimeClientError && error.code === 'runtime_unavailable') {
    if (hasOrchestrationRequestId(error.data)) {
      return message
    }
    return `${message}\nOrca is not running. Run 'orca open' first.`
  }
  // Why: error-specific recovery must win over the generic computer fallback.
  // Classified from the whole error, not just `.code`: a hop that flattens the class leaves only the token.
  const conflict = automationOwnerConflictRecovery(matchAutomationOwnerConflict(error))
  if (conflict) {
    return formatMessageWithNextSteps(stripAutomationOwnerConflictCode(message), conflict.nextSteps)
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
    return `${message}\nOrca is not running. Run 'orca open' first.`
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

export function reportCliError(error: unknown, json: boolean, context: CliErrorContext = {}): void {
  if (json) {
    if (error instanceof RuntimeRpcFailureError) {
      console.log(JSON.stringify(withAutomationOwnerConflictRecovery(error.response), null, 2))
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

/** Machine-readable half of the same recovery the human message carries. */
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
      // Restores the classification a flattening hop dropped, so --json consumers read the conflict, not the transport.
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

function localCliErrorData(error: unknown, context: CliErrorContext): unknown {
  // Why: error-specific recovery must win over the generic computer fallback.
  if (error instanceof RuntimeClientError && error.data !== undefined) {
    return error.data
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
