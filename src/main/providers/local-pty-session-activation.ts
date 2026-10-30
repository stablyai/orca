import type * as pty from 'node-pty'
import { isBracketedPasteSafeShell } from '../../shared/startup-command-submission'
import {
  discardStagedStartupCommand,
  stageStartupCommand,
  startupStagingFailureNotice,
  type StartupCommandStaging
} from '../../shared/startup-command-staging'
import { PtyStartupIngress, type PtyIngressEmission } from '../../shared/pty-startup-ingress'
import { resolvePtyOwnerBackend } from '../../shared/pty-owner-backend'
import { resolveProcessExitCause } from '../../shared/terminal-exit-cause'
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from '../pty/posix-shell-startup-command'
import { getAgentForegroundContextPaths } from './agent-foreground-context-paths'
import { getSpawnedShellName } from './local-pty-launch-helpers'
import type { LocalPtyLaunchPlan } from './local-pty-launch-plan'
import type { LocalPtyProviderOptions } from './local-pty-provider-types'
import {
  clearPtyState,
  dataListeners,
  exitListeners,
  getLoadGeneration,
  ptyAgentForegroundContextPaths,
  ptyAgentSessionIds,
  ptyDisposables,
  ptyExitDisposables,
  ptyIncarnations,
  ptyInitialCwd,
  ptyLoadGeneration,
  ptyPhysicalExits,
  ptyProcesses,
  ptyReportsChildExitStatus,
  ptyShellPath,
  ptyTerminalHandle,
  ptyTerminationMode,
  ptyWorktreeId,
  ptyWslDistroById,
  startupIngressByPty
} from './local-pty-provider-state'
import { createLocalPtyShellReadinessSession } from './local-pty-shell-readiness-session'
import { destroyPtyProcess, createPtyPhysicalExit } from './local-pty-termination'
import { writeStartupCommandWhenShellReady } from './local-pty-shell-ready-startup-command'
import type { PtySpawnOptions, PtySpawnResult } from './pty-provider-contract'

export function activateLocalPtySession(args: {
  id: string
  incarnationId: string
  spawn: PtySpawnOptions
  getOptions: () => LocalPtyProviderOptions
  plan: LocalPtyLaunchPlan
  env: Record<string, string>
  proc: pty.IPty
  reportsChildExitStatus: boolean
  spawnedWslDistro: string | null | undefined
}): PtySpawnResult {
  const { id, incarnationId, spawn, getOptions, plan, env, proc, spawnedWslDistro } = args
  createPtyPhysicalExit(id)
  ptyReportsChildExitStatus.set(id, args.reportsChildExitStatus)
  ptyProcesses.set(id, proc)
  ptyInitialCwd.set(id, plan.cwd)
  if (spawnedWslDistro !== undefined) {
    ptyWslDistroById.set(id, spawnedWslDistro)
  }
  // launchAgent survives command rewrites; recognition also catches typed agent commands.
  if (spawn.launchAgent || plan.startupAgentRecognition) {
    ptyAgentSessionIds.add(id)
  }
  ptyShellPath.set(id, plan.shellPath)
  if (env.ORCA_TERMINAL_HANDLE) {
    ptyTerminalHandle.set(id, env.ORCA_TERMINAL_HANDLE)
  }
  if (spawn.worktreeId) {
    ptyWorktreeId.set(id, spawn.worktreeId)
  }
  ptyAgentForegroundContextPaths.set(
    id,
    getAgentForegroundContextPaths({ cwd: spawn.cwd, worktreeId: spawn.worktreeId })
  )
  ptyLoadGeneration.set(id, getLoadGeneration())
  ptyIncarnations.set(id, incarnationId)
  getOptions().onSpawned?.(id, incarnationId)

  const emitIngressData = (emission: PtyIngressEmission): void => {
    const sequenceChars = emission.rawEndSeq - emission.rawStartSeq
    const { onData } = getOptions()
    if (emission.transformed || sequenceChars !== emission.data.length) {
      onData?.(id, emission.data, Date.now(), sequenceChars, true)
    } else {
      onData?.(id, emission.data, Date.now())
    }
    const runtimeFed = onData ? true : undefined
    for (const cb of dataListeners) {
      cb(
        emission.transformed || sequenceChars !== emission.data.length
          ? {
              id,
              data: emission.data,
              sequenceChars,
              seq: emission.rawEndSeq,
              transformed: true,
              runtimeFed
            }
          : { id, data: emission.data, runtimeFed }
      )
    }
  }
  const startupIngress = new PtyStartupIngress({
    ...(spawn.startupIngress ? { intent: spawn.startupIngress } : {}),
    ownerBackend: resolvePtyOwnerBackend({
      platform: process.platform,
      shellPath: plan.shellPath,
      wslDistro: spawnedWslDistro
    }),
    write: (data) => proc.write(data),
    onEmission: emitIngressData
  })
  startupIngressByPty.set(id, startupIngress)

  const readiness = createLocalPtyShellReadinessSession({
    id,
    spawn,
    plan,
    env,
    proc,
    startupIngress
  })
  const disposables: { dispose: () => void }[] = []
  const onDataDisposable = proc.onData((rawData) => {
    readiness.acceptData(rawData)
  })
  if (onDataDisposable) {
    disposables.push(onDataDisposable)
  }
  ptyDisposables.set(id, disposables)

  let exitedBeforeSpawnReply = false
  let staging: StartupCommandStaging | undefined
  const onExitDisposable = proc.onExit(({ exitCode, signal }) => {
    exitedBeforeSpawnReply = true
    discardStagedStartupCommand(staging)
    // node-pty may pair exitCode 0 with a fatal signal; classify while signal and spawn provenance are available.
    const cause = resolveProcessExitCause({
      exitCode,
      signal,
      hostReportsChildExitStatus: ptyReportsChildExitStatus.get(id)
    })
    const wasTerminationRequested = ptyTerminationMode.has(id)
    ptyPhysicalExits.get(id)?.markExited()
    // Why: neutralize proc.kill before destroy — node-pty SIGHUPs on socket 'close', which can race here and signal a reaped/recycled pid.
    if (process.platform !== 'win32') {
      ;(proc as unknown as { kill: (sig?: string) => void }).kill = () => {}
    }
    readiness.prepareForExit()
    clearPtyState(id)
    startupIngress.drainAndClose()
    startupIngressByPty.delete(id)
    // Release the natural-exit ptmx fd now instead of waiting for GC (docs/fix-pty-fd-leak.md).
    destroyPtyProcess(proc, { alreadyKilled: wasTerminationRequested })
    ptyReportsChildExitStatus.delete(id)
    const { onExit } = getOptions()
    onExit?.(id, exitCode, incarnationId, cause)
    for (const cb of exitListeners) {
      cb({ id, code: exitCode, incarnationId, cause, runtimeFed: onExit ? true : undefined })
    }
  })
  if (onExitDisposable) {
    if (exitedBeforeSpawnReply) {
      onExitDisposable.dispose()
    } else {
      ptyExitDisposables.set(id, onExitDisposable)
    }
  }

  const startupCommandDeliveredByWrapper =
    spawn.command !== undefined &&
    plan.shellReadyLaunch?.env[POSIX_SHELL_STARTUP_COMMAND_ENV] === spawn.command
  if (
    !exitedBeforeSpawnReply &&
    spawn.command &&
    !plan.startupCommandDeliveredInShellArgs &&
    !startupCommandDeliveredByWrapper
  ) {
    // Why: shells with bracketed paste armed take a multiline startup prompt literally; others use raw submit.
    const spawnedShellName = getSpawnedShellName(plan.shellPath).toLowerCase()
    const bracketedPasteSafe =
      process.platform !== 'win32' &&
      isBracketedPasteSafeShell({
        shellName: spawnedShellName,
        waitsForShellReady: plan.shellReadyLaunch?.supportsReadyMarker === true
      })
    staging = stageStartupCommand({
      command: spawn.command,
      shellPath: plan.shellPath,
      orcaBuiltLine: spawn.launchAgent !== undefined
    })
    const notice = startupStagingFailureNotice(staging)
    if (notice) {
      startupIngress.accept(notice)
      console.warn(`[pty] Could not stage startup command for ${id}; typing it in full`, {
        reason: staging.failure
      })
    }
    writeStartupCommandWhenShellReady(
      readiness.shellReadyPromise,
      proc,
      staging.command,
      (cleanup) => {
        readiness.setStartupCommandCleanup(cleanup)
      },
      {
        bracketedPasteSafe
      }
    )
  }

  // Memory collection needs a proven positive OS PID; node-pty can briefly publish zero during spawn.
  const rawPid = proc.pid
  const pid = typeof rawPid === 'number' && Number.isFinite(rawPid) && rawPid > 0 ? rawPid : null
  return {
    id,
    incarnationId,
    pid,
    startupCwdSource: 'request',
    ...(exitedBeforeSpawnReply ? { exitedBeforeSpawnReply: true } : {}),
    ...(spawnedWslDistro !== undefined ? { wslDistro: spawnedWslDistro } : {})
  }
}
