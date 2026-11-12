import type { ResolvedCommand } from './host-routing/wsl-command-resolution'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import { startGitSpan } from '../../observability/instrumentation'
import { createAbortError } from './process-capture/abort-error'
import { resolveGitCommand } from './host-routing/git-command-resolution'
import {
  assertPreparedGitCommand,
  captureGitExecutionContext,
  type GitExecutionContext,
  pendingWslGitPathPreparation
} from './host-routing/wsl-git-path-preparation'
import { untranslatedGitOutputEnv } from './git-environment/git-process-env'
import { prepareWindowsHostGitEnvironment } from './host-routing/windows-host-git-environment'
import type { GitAdmissionTier } from '../../../shared/rpc-contract/git-admission-tier-params'
import { acquireGitAdmission } from './admission/git-subprocess-admission'
import { classifyGitCommand } from '../../../shared/git/commands/git-command-classification'
import { buildNetworkSshPolicyEnv } from './git-environment/git-ssh-policy-env'
import {
  admitWslGit,
  isLocalGitRuntimeRouterInstalled,
  noteWslGitFailure,
  routeLocalGitOptions
} from './host-routing/local-git-runtime-route'
import { gitRunsIn } from './host-routing/git-runs-in'

export type GitSpawnOptions = SpawnOptions & {
  cwd: string
  wslDistro?: string
  /** Runs the host's Git even in a WSL-runtime project (local-git-runtime-route.ts); say why. */
  hostGit?: true
  executionContext?: GitExecutionContext
  admissionTier?: GitAdmissionTier
}

export async function gitSpawnAfterWindowsEnvironmentReady(
  args: string[],
  callerOptions: GitSpawnOptions
): Promise<ChildProcess> {
  let options = routeLocalGitOptions(callerOptions)
  if (options.signal?.aborted) {
    throw createAbortError()
  }
  const lineEndingsReady = pendingWslGitPathPreparation(args, options)
  options = {
    ...options,
    executionContext: lineEndingsReady
      ? await lineEndingsReady
      : captureGitExecutionContext(options)
  }
  const resolved = resolveGitCommand(args, {
    cwd: options.cwd,
    executionContext: options.executionContext,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.env ? { env: options.env } : {})
  })
  const env = await (prepareWindowsHostGitEnvironment(resolved, options.env, options.signal) ??
    options.env)
  if (options.signal?.aborted) {
    throw createAbortError()
  }
  const policyEnv =
    classifyGitCommand(args) === 'network'
      ? (await buildNetworkSshPolicyEnv({ ...options, env }, args)).env
      : env
  return withGitAdmission(
    args,
    policyEnv === options.env ? options : { ...options, env: policyEnv }
  )
}

export async function withGitAdmission(
  args: string[],
  callerOptions: GitSpawnOptions,
  spawnChild?: () => ChildProcess
): Promise<ChildProcess> {
  let options = routeLocalGitOptions(callerOptions)
  const admission = admitWslGit(options)
  if (admission) {
    await admission
  }
  if (!options.executionContext) {
    const ready = pendingWslGitPathPreparation(args, options)
    options = {
      ...options,
      executionContext: ready ? await ready : captureGitExecutionContext(options)
    }
  }
  const resolved = resolveGitCommand(args, options)
  const spawnRouted = spawnChild ?? (() => spawnPreparedGitCommand(args, resolved, options))
  const span = startGitSpan({ args, cwd: options.cwd })
  let grant: Awaited<ReturnType<typeof acquireGitAdmission>> | null = null
  try {
    grant = await acquireGitAdmission({
      args,
      cwd: options.cwd,
      wslDistro: options.wslDistro,
      tier: options.admissionTier,
      signal: options.signal
    })
    span.setAttribute('git.queue_wait_ms', grant.queueWaitMs)
    span.setAttribute('git.runs_in', gitRunsIn(resolved))
    if (options.signal?.aborted) {
      grant.release()
      span.fail(createAbortError())
      throw createAbortError()
    }
    if (spawnChild) {
      assertPreparedGitCommand(resolved, args, options)
    }
    const child = spawnRouted()
    let finalized = false
    let liveError: Error | null = null
    // wsl.exe says a distro is missing on stderr; keep a tail so the failure can name it.
    let stderrTail = ''
    const keepStderr = (chunk: Buffer | string): void => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-2_048)
    }
    if (options.wslDistro && isLocalGitRuntimeRouterInstalled()) {
      child.stderr?.on('data', keepStderr)
    }
    const finalize = (error?: Error): void => {
      if (finalized) {
        return
      }
      finalized = true
      child.stderr?.off('data', keepStderr)
      if (error) {
        noteWslGitFailure(
          options,
          stderrTail ? new Error(`${error.message}\n${stderrTail}`) : error
        )
      }
      child.off('error', handleError)
      child.off('close', handleClose)
      grant?.release()
      if (error) {
        span.fail(error)
      } else {
        span.end()
      }
    }
    const handleError = (error: Error): void => {
      if (!child.pid) {
        finalize(error)
      } else {
        liveError = error
      }
    }
    const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      const exitError =
        liveError ??
        (code === 0 && signal === null
          ? undefined
          : new Error(`git exited with ${code ?? signal ?? 'unknown'}.`))
      finalize(exitError)
    }
    child.on('error', handleError)
    child.once('close', handleClose)
    return child
  } catch (error) {
    grant?.release()
    span.fail(error instanceof Error ? error : new Error(String(error)))
    noteWslGitFailure(options, error)
    throw error
  }
}

export function gitSpawn(args: string[], callerOptions: GitSpawnOptions): ChildProcess {
  const options = routeLocalGitOptions(callerOptions)
  const { wslDistro, admissionTier: _admissionTier, hostGit: _hostGit, ...spawnOptions } = options
  const resolved = resolveGitCommand(args, {
    cwd: options.cwd,
    executionContext: options.executionContext,
    hostGit: options.hostGit,
    ...(wslDistro ? { wslDistro } : {}),
    ...(spawnOptions.env ? { env: spawnOptions.env } : {})
  })
  return spawnPreparedGitCommand(args, resolved, options)
}

export function spawnPreparedGitCommand(
  args: string[],
  resolved: ResolvedCommand,
  options: GitSpawnOptions
): ChildProcess {
  assertPreparedGitCommand(resolved, args, options)
  const {
    wslDistro: _wslDistro,
    admissionTier: _tier,
    hostGit: _hostGit,
    executionContext: _context,
    ...spawnOptions
  } = options
  const spawnStartedAt = performance.now()
  const child = spawn(resolved.binary, resolved.args, {
    ...spawnOptions,
    env: untranslatedGitOutputEnv(spawnOptions.env ?? process.env),
    windowsHide: true,
    cwd: resolved.cwd
  })
  recordSubprocessSpawn(resolved.binary, resolved.args, performance.now() - spawnStartedAt)
  return child
}
