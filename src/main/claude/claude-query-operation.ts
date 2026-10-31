import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import type { ManagedProviderProcess } from '../provider-process/managed-provider-process'
import { withProviderSpawnAbsence } from '../provider-process/provider-executable-missing'
import { withProviderRequestTimeout } from '../provider-process/provider-request-timeout'
import { providerStartupFailureFact } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import type { StructuredAgentStartupFailure } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  ClaudeControlRequestError,
  ClaudeControlRequestTimeoutError,
  runClaudeControl
} from './claude-agent-sdk-control-requests'
import { claudeInitializationAuthError } from './structured/claude-structured-init-proof'
import { claudeStreamJsonExitError } from './claude-stream-json-exit-error'

export const CLAUDE_INITIALIZE_TIMEOUT_MS = 60_000

/** One captured Query owns initialize and the failure projected by both host consumers. */
export function createClaudeQueryOperation(account?: AgentSessionAccountKind) {
  const result = Promise.withResolvers<unknown>()
  let outcome: 'pending' | 'ready' | 'failed' = 'pending'
  let failure: StructuredAgentStartupFailure | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const reject = (cause: unknown): void => {
    if (outcome !== 'pending') {
      return
    }
    const error = cause instanceof Error ? cause : new Error(String(cause))
    failure = { error, failure: providerStartupFailureFact(error), initiator: 'startup-failure' }
    outcome = 'failed'
    clearTimeout(timer)
    result.reject(error)
  }
  void result.promise.catch(() => {})
  return {
    result: result.promise,
    get failure() {
      return failure
    },
    reject,
    capture<T>(construct: () => T): T {
      try {
        return construct()
      } catch (cause) {
        reject(cause)
        throw cause
      }
    },
    start(
      query: Pick<Query, 'initializationResult'>,
      managed?: Pick<
        ManagedProviderProcess,
        'launchReport' | 'finishDiagnostics' | 'stderrTail' | 'exitStatus' | 'spawnAbsence'
      >,
      sourceDone?: Promise<void>
    ): void {
      timer = setTimeout(() => {
        managed?.launchReport.abandon()
        reject(
          withProviderRequestTimeout(
            new Error(`claude did not answer initialize within ${CLAUDE_INITIALIZE_TIMEOUT_MS}ms`),
            {
              method: 'initialize',
              timeoutMs: CLAUDE_INITIALIZE_TIMEOUT_MS
            }
          )
        )
      }, CLAUDE_INITIALIZE_TIMEOUT_MS)
      timer.unref?.()
      void sourceDone?.then(
        () => managed?.launchReport.abandon(),
        () => managed?.launchReport.abandon()
      )
      void runClaudeControl('initialize', () => query.initializationResult(), null)
        .then(
          (value) => {
            const refusal = claudeInitializationAuthError(value, account)
            if (refusal) {
              reject(refusal)
              return
            }
            if (outcome !== 'pending') {
              return
            }
            outcome = 'ready'
            clearTimeout(timer)
            result.resolve(value)
          },
          async (cause: unknown) => {
            if (
              cause instanceof ClaudeControlRequestTimeoutError ||
              (cause instanceof ClaudeControlRequestError &&
                managed?.launchReport.record?.kind !== 'failed' &&
                !managed?.spawnAbsence)
            ) {
              reject(cause)
              return
            }
            // Source completion abandons only observation; no receive finalizer awaits this result.
            const report = await managed?.launchReport.done
            const absence = managed?.spawnAbsence ?? null
            const diagnosticFailure = await managed?.finishDiagnostics().then(
              () => undefined,
              (error: unknown) => error
            )
            const received = cause instanceof Error ? cause : new Error(String(cause))
            const original =
              diagnosticFailure === undefined
                ? received
                : new AggregateError([received, diagnosticFailure], received.message)
            const error =
              report?.kind === 'failed'
                ? new Error(report.error.message, {
                    cause: new AggregateError([report.error, original], report.error.message)
                  })
                : claudeStreamJsonExitError(
                    managed?.stderrTail() ?? '',
                    managed?.exitStatus ?? null,
                    original
                  )
            reject(withProviderSpawnAbsence(error, absence))
          }
        )
        .catch(reject)
    }
  }
}
