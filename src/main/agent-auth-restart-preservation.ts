import type { ClaudeRuntimeAuthService } from './claude-accounts/runtime-auth-service'
import type { CodexRuntimeHomeService } from './codex-accounts/runtime-home-service'
import type { Store } from './persistence'

const AUTH_PRESERVATION_TIMEOUT_MS = 2_000

type CodexRuntimeAuthSync = Pick<
  CodexRuntimeHomeService,
  'syncForCurrentSelection' | 'syncActiveWslSelectionsBeforeRestart'
>
type ClaudeRuntimeAuthSync = Pick<ClaudeRuntimeAuthService, 'syncForCurrentSelection'>
type ShutdownStore = Pick<Store, 'flush'>

type AuthPreservationStep = 'Codex auth preservation' | 'Claude auth preservation'

export type AgentAuthRestartPreservationOptions = {
  codexRuntimeHome?: CodexRuntimeAuthSync | null
  claudeRuntimeAuth?: ClaudeRuntimeAuthSync | null
  store?: ShutdownStore | null
}

export async function preserveAgentAuthBeforeRestart({
  codexRuntimeHome,
  claudeRuntimeAuth,
  store
}: AgentAuthRestartPreservationOptions): Promise<void> {
  const startedAt = Date.now()

  runCodexPreservationStep(codexRuntimeHome)

  const remainingMs = Math.max(0, AUTH_PRESERVATION_TIMEOUT_MS - (Date.now() - startedAt))
  if (claudeRuntimeAuth && remainingMs > 0) {
    await runWithinLifecycleTimeout(
      'Claude auth preservation',
      () => claudeRuntimeAuth.syncForCurrentSelection(),
      remainingMs
    )
  } else if (claudeRuntimeAuth) {
    logStepTimeout('Claude auth preservation', 0)
  }

  if (codexRuntimeHome && Date.now() - startedAt < AUTH_PRESERVATION_TIMEOUT_MS) {
    runWslCodexPreservationStep(codexRuntimeHome)
  } else if (codexRuntimeHome) {
    logStepTimeout('Codex auth preservation', 0)
  }

  try {
    store?.flush()
  } catch (error) {
    logStoreFlushFailure(error)
  }
}

function runCodexPreservationStep(codexRuntimeHome: CodexRuntimeAuthSync | null | undefined): void {
  try {
    codexRuntimeHome?.syncForCurrentSelection()
  } catch (error) {
    logStepFailure('Codex auth preservation', error)
  }
}

function runWslCodexPreservationStep(
  codexRuntimeHome: CodexRuntimeAuthSync | null | undefined
): void {
  try {
    codexRuntimeHome?.syncActiveWslSelectionsBeforeRestart()
  } catch (error) {
    logStepFailure('Codex auth preservation', error)
  }
}

async function runWithinLifecycleTimeout(
  step: AuthPreservationStep,
  run: () => Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  const operation = Promise.resolve()
    .then(run)
    .catch((error) => {
      logStepFailure(step, error)
    })

  // Why: this timeout only releases the restart/update path. It does not
  // cancel a sync that already started, and Codex sync is synchronous today.
  const timeoutResult = new Promise<'timeout'>((resolve) => {
    timeout = setTimeout(() => resolve('timeout'), timeoutMs)
  })

  const result = await Promise.race([operation.then(() => 'done' as const), timeoutResult])
  if (result === 'timeout') {
    logStepTimeout(step, timeoutMs)
    return
  }

  if (timeout) {
    clearTimeout(timeout)
  }
}

function logStepFailure(step: AuthPreservationStep, error: unknown): void {
  console.warn(
    `[agent-auth-restart] ${step} failed (${describeErrorKind(error)}); continuing restart/update`
  )
}

function logStepTimeout(step: AuthPreservationStep, timeoutMs: number): void {
  console.warn(`[agent-auth-restart] ${step} exceeded ${timeoutMs}ms; continuing restart/update`)
}

function logStoreFlushFailure(error: unknown): void {
  console.warn(
    `[agent-auth-restart] Store flush failed (${describeErrorKind(error)}); continuing restart/update`
  )
}

function describeErrorKind(error: unknown): string {
  if (error instanceof Error) {
    return error.name || 'Error'
  }
  return typeof error
}
