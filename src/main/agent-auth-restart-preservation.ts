import type { ClaudeRuntimeAuthService } from './claude-accounts/runtime-auth-service'
import type { CodexRuntimeHomeService } from './codex-accounts/runtime-home-service'
import type { Store } from './persistence'

const AUTH_PRESERVATION_TIMEOUT_MS = 2_000

type CodexRuntimeAuthSync = Pick<CodexRuntimeHomeService, 'syncForCurrentSelection'> &
  Partial<Pick<CodexRuntimeHomeService, 'syncActiveWslSelectionsBeforeRestart'>>
type ClaudeRuntimeAuthSync = Pick<ClaudeRuntimeAuthService, 'syncForCurrentSelection'>
type ShutdownStore = Pick<Store, 'flushPendingOrThrowAsync'>

type AuthPreservationStep =
  | 'Codex auth preservation'
  | 'Claude auth preservation'
  | 'Store persistence'

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
  // Why: the drain owns guest-process timeouts; a shared 2s cutoff can relaunch before promotion.
  const wslCodexPreservation = runWslCodexPreservationStep(codexRuntimeHome)

  const claudeRemainingMs = remainingLifecycleTime(startedAt)
  if (claudeRuntimeAuth && claudeRemainingMs > 0) {
    await runWithinLifecycleTimeout(
      'Claude auth preservation',
      () => claudeRuntimeAuth.syncForCurrentSelection(),
      claudeRemainingMs
    )
  } else if (claudeRuntimeAuth) {
    logStepTimeout('Claude auth preservation', 0)
  }

  const storePreservation = store
    ? runWithinLifecycleTimeout(
        'Store persistence',
        () => store.flushPendingOrThrowAsync(),
        remainingLifecycleTime(startedAt)
      )
    : Promise.resolve()
  await Promise.all([wslCodexPreservation, storePreservation])
}

function remainingLifecycleTime(startedAt: number): number {
  return Math.max(0, AUTH_PRESERVATION_TIMEOUT_MS - (Date.now() - startedAt))
}

function runCodexPreservationStep(codexRuntimeHome: CodexRuntimeAuthSync | null | undefined): void {
  try {
    codexRuntimeHome?.syncForCurrentSelection()
  } catch (error) {
    logStepFailure('Codex auth preservation', error)
  }
}

async function runWslCodexPreservationStep(
  codexRuntimeHome: CodexRuntimeAuthSync | null | undefined
): Promise<void> {
  try {
    await codexRuntimeHome?.syncActiveWslSelectionsBeforeRestart?.()
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
  // cancel a sync that already started.
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

function describeErrorKind(error: unknown): string {
  if (error instanceof Error) {
    return error.name || 'Error'
  }
  return typeof error
}
