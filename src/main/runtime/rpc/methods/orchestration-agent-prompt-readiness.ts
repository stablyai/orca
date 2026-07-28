import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-types'
import { resolveOrchestrationAgentReadinessTimeoutMs } from '../../../../shared/orchestration-dispatch-readiness'
import { OrchestrationOperationOutcomeUnknownError } from '../../../../shared/orchestration-agent-prompt-outcome'

type PromptTarget = {
  paneKey: string
  processIncarnation: string
}

type ReadinessOptions = {
  deadlineMs: number
  signal?: AbortSignal
  onWaitResult?: (wait: RuntimeTerminalWait) => void
}

function assertReadinessWindow(options: ReadinessOptions): void {
  if (options.signal?.aborted) {
    throw new Error('request_aborted')
  }
  if (Date.now() >= options.deadlineMs) {
    throw new Error('Agent did not become ready (timeout).')
  }
}

export function createOrchestrationAgentReadinessDeadline(
  method: 'orchestration.workerStart' | 'orchestration.federationAttachStart',
  params: unknown,
  signal?: AbortSignal
): { deadlineMs: number; timeoutMs: number; signal: AbortSignal } {
  if (signal?.aborted) {
    throw new Error('request_aborted')
  }
  const timeoutMs = resolveOrchestrationAgentReadinessTimeoutMs(method, params) ?? 60_000
  const deadlineSignal = AbortSignal.timeout(timeoutMs)
  return {
    deadlineMs: Date.now() + timeoutMs,
    timeoutMs,
    signal: signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal
  }
}

export function remainingOrchestrationAgentReadinessTime(
  deadlineMs: number,
  signal?: AbortSignal
): number {
  if (signal?.aborted) {
    throw new Error('request_aborted')
  }
  const remaining = deadlineMs - Date.now()
  if (remaining <= 0) {
    throw new Error('Agent did not become ready (timeout).')
  }
  return remaining
}

export function waitForOrchestrationProvisioning<T>(
  provisioning: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new OrchestrationOperationOutcomeUnknownError(
        'Worker provisioning',
        new Error('request_aborted')
      )
    )
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        new OrchestrationOperationOutcomeUnknownError(
          'Worker provisioning',
          new Error('request_aborted')
        )
      )
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void provisioning.then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function readinessError(wait: { status: string; blockedReason?: string }): Error {
  return new Error(
    wait.blockedReason
      ? `Agent startup blocked: ${wait.blockedReason}`
      : `Agent did not become ready (${wait.status}).`
  )
}

export async function waitForOrchestrationAgentReady(
  runtime: OrcaRuntimeService,
  handle: string,
  options: ReadinessOptions
): Promise<void> {
  assertReadinessWindow(options)
  let wait
  try {
    wait = await runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      timeoutMs: options.deadlineMs - Date.now(),
      signal: options.signal,
      strictTuiIdle: true
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'timeout') {
      throw new Error('Agent did not become ready (timeout).')
    }
    throw error
  }
  options.onWaitResult?.(wait)
  assertReadinessWindow(options)
  if (!wait.satisfied) {
    throw readinessError(wait)
  }
}

export function createOrchestrationAgentPromptGuard(
  runtime: OrcaRuntimeService,
  handle: string,
  target: PromptTarget,
  options: ReadinessOptions
): () => Promise<void> {
  const assertIdentity = (): void => {
    if (
      runtime.getTerminalPaneKey(handle) !== target.paneKey ||
      runtime.getTerminalProcessIncarnation(handle) !== target.processIncarnation
    ) {
      throw new Error('terminal_handle_stale')
    }
  }
  return async (): Promise<void> => {
    assertReadinessWindow(options)
    assertIdentity()
    let wait
    try {
      wait = await runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs: 1,
        signal: options.signal,
        strictTuiIdle: true
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'timeout') {
        throw new Error('Agent is no longer ready.')
      }
      throw error
    }
    assertReadinessWindow(options)
    assertIdentity()
    if (!wait.satisfied) {
      throw readinessError(wait)
    }
  }
}

export async function prepareOrchestrationAgentPrompt(
  runtime: OrcaRuntimeService,
  handle: string,
  options: ReadinessOptions
): Promise<PromptTarget & { beforeWrite: () => Promise<void> }> {
  await waitForOrchestrationAgentReady(runtime, handle, options)
  const paneKey = runtime.getTerminalPaneKey(handle)
  const processIncarnation = runtime.getTerminalProcessIncarnation(handle)
  if (!paneKey || !processIncarnation) {
    throw new Error('stable_pane_required')
  }
  const beforeWrite = createOrchestrationAgentPromptGuard(
    runtime,
    handle,
    { paneKey, processIncarnation },
    options
  )
  await beforeWrite()
  return { paneKey, processIncarnation, beforeWrite }
}
