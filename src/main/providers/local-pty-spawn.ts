import { randomUUID } from 'node:crypto'
import { win32 as pathWin32 } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { JCODE_RUNTIME_DIR_ENV_KEY } from '../../shared/jcode-runtime-dir'
import { prewarmJcodeDaemon } from '../jcode/daemon-prewarm'
import { SessionNotFoundError } from '../daemon/daemon-errors'
import { prepareMacosTccLoginShell } from './macos-tcc-login-shell'
import { finalizeLocalPtySpawnEnvironment } from './local-pty-finalize-environment'
import { normalizeLocalCallerSessionId } from './local-pty-launch-helpers'
import { createLocalPtyLaunchPlan, DeferredLocalPtyLaunchPlan } from './local-pty-launch-plan'
import type { LocalPtyProviderOptions } from './local-pty-provider-types'
import { allocatePtyId, ptyShutdownOperations } from './local-pty-provider-state'
import { activateLocalPtySession } from './local-pty-session-activation'
import {
  buildLocalPtySpawnEnvironment,
  enforceLocalPtySpawnEnvironmentOverrides
} from './local-pty-spawn-environment'
import {
  runCancelableLocalPtySpawn,
  reattachLocalPty,
  reserveLocalPtySpawn
} from './local-pty-spawn-state'
import { loadLocalPtyRuntimeSpawn } from './local-pty-runtime-spawn'
import { destroyPtyProcess } from './local-pty-termination'
import { updateHistoryEnvForFallback } from '../terminal-history'
import type { PtySpawnOptions, PtySpawnResult } from './types'

export async function spawnLocalPty(
  args: PtySpawnOptions,
  getOptions: () => LocalPtyProviderOptions
): Promise<PtySpawnResult> {
  const reattachId = normalizeLocalCallerSessionId(args.sessionId, args.attachOnly === true)
  if (reattachId) {
    const pendingShutdown = ptyShutdownOperations.get(reattachId)
    if (pendingShutdown) {
      await pendingShutdown.promise
    }
    const existing = reattachLocalPty(reattachId, args.cols, args.rows)
    if (existing) {
      return existing
    }
  }
  if (args.attachOnly) {
    throw new SessionNotFoundError(args.sessionId ?? '')
  }
  // Why: the jcode runtime dir is stamped into the spawn env by the pty:spawn
  // handler and the runtime env builder; create it async here at the provider
  // chokepoint both paths pass through, keeping the sync spawn path free of
  // filesystem syscalls.
  const jcodeRuntimeDir = args.env?.[JCODE_RUNTIME_DIR_ENV_KEY]
  if (jcodeRuntimeDir) {
    try {
      await mkdir(jcodeRuntimeDir, { recursive: true })
    } catch {
      // Why non-fatal: the dir is stamped on every local pane, so an EACCES on a
      // shared /tmp/orca-jcode or a read-only TMPDIR would otherwise stop a plain
      // shell from opening. Drop the variable and let jcode use its own default.
      delete args.env?.[JCODE_RUNTIME_DIR_ENV_KEY]
    }
  }
  const id = allocatePtyId(reattachId ?? undefined)
  return runCancelableLocalPtySpawn(id, async (throwIfCanceled, cancellation) => {
    const incarnationId = randomUUID()
    let plan = createLocalPtyLaunchPlan(args, getOptions)
    if (plan instanceof DeferredLocalPtyLaunchPlan) {
      const available = await plan.availability
      throwIfCanceled()
      plan = plan.finish(available)
    }
    throwIfCanceled()
    const envResult = buildLocalPtySpawnEnvironment({
      id,
      spawn: args,
      getOptions,
      plan
    })
    const finalEnv = envResult instanceof Promise ? await envResult : envResult
    throwIfCanceled()
    enforceLocalPtySpawnEnvironmentOverrides(args, finalEnv)
    const historyResult = finalizeLocalPtySpawnEnvironment({
      spawn: args,
      getOptions,
      plan,
      env: finalEnv
    })
    // Why here rather than beside the mkdir above: the daemon inherits this env, and
    // only finalEnv carries the hook port and token that buildPtyHostEnv adds — the
    // managed hook script exits without them, so a daemon warmed from the raw spawn
    // env would report no lifecycle events at all.
    prewarmJcodeDaemon({
      launchAgent: args.launchAgent,
      runtimeDir: finalEnv[JCODE_RUNTIME_DIR_ENV_KEY],
      cwd: args.cwd,
      env: finalEnv
    })

    const fallbackHistory = historyResult?.historyDir ? historyResult : undefined
    const [spawn] = await Promise.all([loadLocalPtyRuntimeSpawn(), prepareMacosTccLoginShell()])
    return reserveLocalPtySpawn(id, async () => {
      const checkCanceled = (): void => {
        throwIfCanceled()
        if (args.signal?.aborted) {
          throw new Error('client_disconnected')
        }
      }
      checkCanceled()
      // Why: another same-id request can win while this one awaits preflight; attach before launching a redundant shell.
      const concurrentWinner = reattachId ? reattachLocalPty(id, args.cols, args.rows) : null
      if (concurrentWinner) {
        return concurrentWinner
      }
      const pendingSpawn = spawn({
        shellPath: plan.shellPath,
        shellArgs: plan.shellArgs,
        cols: args.cols,
        rows: args.rows,
        cwd: plan.effectiveCwd,
        env: finalEnv,
        termName: finalEnv.TERM,
        signal: args.signal ? AbortSignal.any([args.signal, cancellation]) : cancellation,
        getShellReadyConfig: plan.getFallbackShellReadyConfig,
        preLaunchEnv: plan.primaryPreLaunchEnv,
        // Why: on zsh→bash fallback HISTFILE still points to zsh_history; update before spawn so the child inherits it (design doc §8).
        onBeforeFallbackSpawn: fallbackHistory
          ? (env, fallbackShell) => updateHistoryEnvForFallback(env, fallbackShell, fallbackHistory)
          : undefined,
        windowsFallbackAttempts: plan.windowsFallbackAttempts
      })
      const spawnResult = pendingSpawn instanceof Promise ? await pendingSpawn : pendingSpawn
      try {
        checkCanceled()
      } catch (error) {
        try {
          spawnResult.process.kill('SIGKILL')
        } finally {
          destroyPtyProcess(spawnResult.process)
        }
        throw error
      }
      args.onPtySpawnCommitted?.()
      plan.shellPath = spawnResult.shellPath
      // Why: a Windows fallback embeds its startup command in argv; honor the winning shell's delivery flag to avoid a double write.
      if (spawnResult.startupCommandDeliveredInShellArgs !== undefined) {
        plan.startupCommandDeliveredInShellArgs = spawnResult.startupCommandDeliveredInShellArgs
      }
      if (args.command && plan.getFallbackShellReadyConfig) {
        plan.shellReadyLaunch = plan.getFallbackShellReadyConfig(plan.shellPath)
      }

      if (process.platform !== 'win32') {
        finalEnv.SHELL = plan.shellPath
      }

      const proc = spawnResult.process
      const spawnedShellIsWsl =
        process.platform === 'win32' &&
        pathWin32.basename(plan.shellPath).toLowerCase() === 'wsl.exe'
      const spawnedWslDistro = spawnedShellIsWsl
        ? (plan.launchWslDistro ?? undefined)
        : process.platform === 'win32'
          ? null
          : undefined
      return activateLocalPtySession({
        id,
        incarnationId,
        spawn: args,
        getOptions,
        plan,
        env: finalEnv,
        proc,
        reportsChildExitStatus: spawnResult.reportsChildExitStatus !== false,
        spawnedWslDistro
      })
    })
  })
}
