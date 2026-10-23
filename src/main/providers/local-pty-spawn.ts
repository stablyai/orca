import { randomUUID } from 'node:crypto'
import { win32 as pathWin32 } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { JCODE_RUNTIME_DIR_ENV_KEY } from '../../shared/jcode-runtime-dir'
import { SessionNotFoundError } from '../daemon/daemon-errors'
import { prepareMacosTccLoginShell } from './macos-tcc-login-shell'
import { finalizeLocalPtySpawnEnvironment } from './local-pty-finalize-environment'
import { normalizeLocalCallerSessionId } from './local-pty-launch-helpers'
import {
  createLocalPtyLaunchPlan,
  DeferredLocalPtyLaunchPlan,
  type LocalPtyLaunchPlan
} from './local-pty-launch-plan'
import type { LocalPtyProviderOptions } from './local-pty-provider-types'
import { validateWorkingDirectory, WorkingDirectoryValidationAbortedError } from './local-pty-utils'
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
import type { PtySpawnOptions, PtySpawnResult } from './pty-provider-contract'

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
  // Validate the selected runtime directory before starting a fresh local process.
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
    const initialPlan = createLocalPtyLaunchPlan(args, getOptions)
    let plan: LocalPtyLaunchPlan | undefined
    let handedOffStaging = false
    try {
      if (initialPlan instanceof DeferredLocalPtyLaunchPlan) {
        const available = await initialPlan.availability
        throwIfCanceled()
        plan = initialPlan.finish(available)
      } else {
        plan = initialPlan
      }
      throwIfCanceled()
      const launchPlan = plan
      if (args.prevalidatedCwd !== launchPlan.validationCwd) {
        try {
          await validateWorkingDirectory(launchPlan.validationCwd, cancellation)
        } catch (error) {
          // Why: an abandoned probe keeps running for other waiters; report the spawn's own cancel.
          if (error instanceof WorkingDirectoryValidationAbortedError) {
            throwIfCanceled()
          }
          throw error
        }
        throwIfCanceled()
      }
      const envResult = buildLocalPtySpawnEnvironment({
        id,
        spawn: args,
        getOptions,
        plan: launchPlan
      })
      const finalEnv = envResult instanceof Promise ? await envResult : envResult
      throwIfCanceled()
      enforceLocalPtySpawnEnvironmentOverrides(args, finalEnv)
      const historyResult = finalizeLocalPtySpawnEnvironment({
        spawn: args,
        getOptions,
        plan: launchPlan,
        env: finalEnv
      })

      const fallbackHistory = historyResult?.historyDir ? historyResult : undefined
      const [spawn] = await Promise.all([loadLocalPtyRuntimeSpawn(), prepareMacosTccLoginShell()])
      const result = await reserveLocalPtySpawn(id, async () => {
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
          launchPlan.startupCommandStaging?.cleanup()
          launchPlan.startupCommandStaging = undefined
          return concurrentWinner
        }
        const pendingSpawn = spawn({
          shellPath: launchPlan.shellPath,
          shellArgs: launchPlan.shellArgs,
          cols: args.cols,
          rows: args.rows,
          cwd: launchPlan.effectiveCwd,
          env: finalEnv,
          termName: finalEnv.TERM,
          signal: args.signal ? AbortSignal.any([args.signal, cancellation]) : cancellation,
          startupCommandStaging: launchPlan.startupCommandStaging,
          getShellReadyConfig: launchPlan.getFallbackShellReadyConfig,
          preLaunchEnv: launchPlan.primaryPreLaunchEnv,
          // Why: on zsh→bash fallback HISTFILE still points to zsh_history; update before spawn so the child inherits it (design doc §8).
          onBeforeFallbackSpawn: fallbackHistory
            ? (env, fallbackShell) =>
                updateHistoryEnvForFallback(env, fallbackShell, fallbackHistory)
            : undefined,
          windowsFallbackAttempts: launchPlan.windowsFallbackAttempts
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
        launchPlan.shellPath = spawnResult.shellPath
        if (spawnResult.startupCommandStaging) {
          launchPlan.startupCommandStaging = spawnResult.startupCommandStaging
        }
        // Why: a Windows fallback embeds its startup command in argv; honor the winning shell's delivery flag to avoid a double write.
        if (spawnResult.startupCommandDeliveredInShellArgs !== undefined) {
          launchPlan.startupCommandDeliveredInShellArgs =
            spawnResult.startupCommandDeliveredInShellArgs
        }
        if (args.command && launchPlan.getFallbackShellReadyConfig) {
          launchPlan.shellReadyLaunch = launchPlan.getFallbackShellReadyConfig(launchPlan.shellPath)
        }

        if (process.platform !== 'win32') {
          finalEnv.SHELL = launchPlan.shellPath
        }

        const proc = spawnResult.process
        const spawnedShellIsWsl =
          process.platform === 'win32' &&
          pathWin32.basename(launchPlan.shellPath).toLowerCase() === 'wsl.exe'
        const spawnedWslDistro = spawnedShellIsWsl
          ? (launchPlan.launchWslDistro ?? undefined)
          : process.platform === 'win32'
            ? null
            : undefined
        return activateLocalPtySession({
          id,
          incarnationId,
          spawn: args,
          getOptions,
          plan: launchPlan,
          env: finalEnv,
          proc,
          reportsChildExitStatus: spawnResult.reportsChildExitStatus !== false,
          spawnedWslDistro
        })
      })
      handedOffStaging = true
      return result
    } finally {
      if (!handedOffStaging) {
        plan?.startupCommandStaging?.cleanup()
      }
    }
  })
}
