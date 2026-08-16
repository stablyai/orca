import { GLAB_EXEC_METHOD } from '../../shared/ssh-types'
import { GIT_CAPABILITY_RETRY_INTERVAL_MS } from '../../shared/git-capability-cache'
import { JsonRpcErrorCode } from '../ssh/relay-protocol'
import { getActiveMultiplexer, getSshConnectionStore } from '../ipc/ssh'

export { GLAB_EXEC_METHOD }

type GlabRemoteExecResult = {
  stdout?: unknown
  stderr?: unknown
  exitCode?: unknown
  timedOut?: unknown
  spawnError?: unknown
  outputLimitExceeded?: unknown
}

type MuxLike = {
  request: (
    method: string,
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ) => Promise<unknown>
}

export type GlabSshExecutionDeps = {
  getTarget: (id: string) => { runGitLabCliOnHost?: boolean } | undefined
  getMux: (id: string) => MuxLike | undefined
}

const defaultDeps: GlabSshExecutionDeps = {
  getTarget: (id) => getSshConnectionStore()?.getTarget(id),
  getMux: (id) => getActiveMultiplexer(id)
}

let deps: GlabSshExecutionDeps = defaultDeps

/** @internal test seam */
export function setGlabSshExecutionDepsForTests(next: Partial<GlabSshExecutionDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps
}

type CapabilityProbeOutcome = 'supported' | 'unsupported' | 'unknown'

type GlabRemoteCapabilityState = {
  supported: boolean
  unsupportedUntilMs?: number
  inFlight?: Promise<CapabilityProbeOutcome>
}

// Why: reconnect replaces the mux object; WeakMap drops stale capability results automatically.
let capabilitiesByMux = new WeakMap<object, GlabRemoteCapabilityState>()

/** @internal test seam */
export function clearGlabSshCapabilityStateForTests(): void {
  capabilitiesByMux = new WeakMap()
}

function getCapabilityState(mux: object): GlabRemoteCapabilityState {
  let state = capabilitiesByMux.get(mux)
  if (!state) {
    state = { supported: false }
    capabilitiesByMux.set(mux, state)
  }
  return state
}

function isMethodNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  return (err as { code?: unknown }).code === JsonRpcErrorCode.MethodNotFound
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function outputLimitExceededStream(
  value: unknown
): 'stdout' | 'stderr' | undefined {
  return value === 'stdout' || value === 'stderr' ? value : undefined
}

function throwRemoteGlabFailure(result: GlabRemoteExecResult): never {
  const stdout = asString(result.stdout)
  const stderr = asString(result.stderr)
  const spawnError = typeof result.spawnError === 'string' ? result.spawnError : undefined
  const timedOut = result.timedOut === true
  const outputLimitExceeded = outputLimitExceededStream(result.outputLimitExceeded)
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null
  const message =
    spawnError ??
    (timedOut
      ? 'glab timed out on SSH host'
      : outputLimitExceeded
        ? `glab ${outputLimitExceeded} exceeded capture limit on SSH host`
        : stderr.trim() || `glab exited with code ${exitCode ?? 'unknown'} on SSH host`)
  const error = new Error(message) as Error & {
    code?: string | number | null
    stdout?: string
    stderr?: string
  }
  error.code = spawnError ? 'ENOENT' : exitCode
  error.stdout = stdout
  error.stderr = stderr
  throw error
}

async function requestRemoteGlab(
  mux: MuxLike,
  args: string[],
  options: {
    remoteCwd?: string
    timeout?: number
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
  }
): Promise<{ stdout: string; stderr: string }> {
  const result = (await mux.request(
    GLAB_EXEC_METHOD,
    {
      args,
      ...(options.remoteCwd ? { cwd: options.remoteCwd } : {}),
      ...(typeof options.timeout === 'number' ? { timeoutMs: options.timeout } : {}),
      ...(options.env ? { env: options.env } : {})
    },
    options.signal ? { signal: options.signal } : undefined
  )) as GlabRemoteExecResult

  if (typeof result.spawnError === 'string' && result.spawnError.length > 0) {
    throwRemoteGlabFailure(result)
  }
  if (result.timedOut === true) {
    throwRemoteGlabFailure(result)
  }
  if (outputLimitExceededStream(result.outputLimitExceeded)) {
    throwRemoteGlabFailure(result)
  }
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null
  if (exitCode !== 0) {
    throwRemoteGlabFailure(result)
  }
  return {
    stdout: asString(result.stdout),
    stderr: asString(result.stderr)
  }
}

/**
 * When the SSH target opts in and a live mux exists, run glab on the host.
 * Returns null to signal "use local path" (flag off, disconnected, or capability unavailable).
 */
export async function tryGlabOnSshHost(
  args: string[],
  options: {
    sshTargetId: string
    remoteCwd?: string
    timeout?: number
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
  }
): Promise<{ stdout: string; stderr: string } | null> {
  const target = deps.getTarget(options.sshTargetId)
  if (!target?.runGitLabCliOnHost) {
    return null
  }
  const mux = deps.getMux(options.sshTargetId)
  if (!mux) {
    return null
  }

  const state = getCapabilityState(mux)
  const nowMs = Date.now()
  if (
    !state.supported &&
    state.unsupportedUntilMs !== undefined &&
    nowMs < state.unsupportedUntilMs
  ) {
    return null
  }

  const runPreferred = (): Promise<{ stdout: string; stderr: string }> =>
    requestRemoteGlab(mux, args, options)

  if (state.supported) {
    return runPreferred()
  }

  if (state.inFlight) {
    const outcome = await state.inFlight
    if (outcome === 'unsupported') {
      return null
    }
    if (
      !state.supported &&
      state.unsupportedUntilMs !== undefined &&
      Date.now() < state.unsupportedUntilMs
    ) {
      return null
    }
    return runPreferred()
  }

  let settleProbe!: (outcome: CapabilityProbeOutcome) => void
  const probe = new Promise<CapabilityProbeOutcome>((resolve) => {
    settleProbe = resolve
  })
  state.inFlight = probe
  try {
    const result = await runPreferred()
    state.supported = true
    state.unsupportedUntilMs = undefined
    settleProbe('supported')
    return result
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      // Why: old relays lack glab.exec; cache unavailable so we don't re-probe every MR poll.
      state.supported = false
      state.unsupportedUntilMs = Date.now() + GIT_CAPABILITY_RETRY_INTERVAL_MS
      settleProbe('unsupported')
      return null
    }
    // Handler exists; a glab-level failure is not a protocol capability miss.
    state.supported = true
    state.unsupportedUntilMs = undefined
    settleProbe('unknown')
    throw error
  } finally {
    if (state.inFlight === probe) {
      state.inFlight = undefined
    }
  }
}
