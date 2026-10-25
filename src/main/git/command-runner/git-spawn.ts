import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import { startGitSpan } from '../../observability/instrumentation'
import { createAbortError } from './abort-error'
import { resolveGitCommand } from './git-command-resolution'
import { pendingWslDriveCheckoutGitRouting } from '../wsl-drive-checkout-git-routing'
import { untranslatedGitOutputEnv } from './git-process-env'
import { prepareWindowsHostGitEnvironment } from './windows-host-git-environment'
import type { GitAdmissionTier } from './git-exec-options'
import { acquireGitAdmission } from './git-subprocess-admission'
import { classifyGitCommand } from '../../../shared/git-command-classification'
import { buildNetworkSshPolicyEnv } from './git-ssh-policy-env'
import { admitWslGit, noteWslGitFailure, routeLocalGitOptions } from './local-git-runtime-route'

export type GitSpawnOptions = SpawnOptions & {
  cwd: string
  wslDistro?: string
  /** Runs the host's Git even in a WSL-runtime project (local-git-runtime-route.ts); say why. */
  hostGit?: true
  admissionTier?: GitAdmissionTier
}

export async function gitSpawnAfterWindowsEnvironmentReady(
  args: string[],
  callerOptions: GitSpawnOptions
): Promise<ChildProcess> {
  const options = routeLocalGitOptions(callerOptions)
  if (options.signal?.aborted) {
    throw createAbortError()
  }
  const lineEndingsReady = pendingWslDriveCheckoutGitRouting(args, options)
  if (lineEndingsReady) {
    await lineEndingsReady
  }
  const resolved = resolveGitCommand(args, {
    cwd: options.cwd,
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
  const options = routeLocalGitOptions(callerOptions)
  const spawnRouted = spawnChild ?? (() => gitSpawn(args, options))
  await admitWslGit(options)
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
    if (options.signal?.aborted) {
      grant.release()
      span.fail(createAbortError())
      throw createAbortError()
    }
    const child = spawnRouted()
    let finalized = false
    let liveError: Error | null = null
    // wsl.exe says a distro is missing on stderr; keep a tail so the failure can name it.
    let stderrTail = ''
    const keepStderr = (chunk: Buffer | string): void => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-2_048)
    }
    if (options.wslDistro) {
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
    ...(wslDistro ? { wslDistro } : {}),
    ...(spawnOptions.env ? { env: spawnOptions.env } : {})
  })
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
