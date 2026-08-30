import { win32 as pathWin32 } from 'node:path'
import type * as pty from 'node-pty'
import { isBracketedPasteSafeShell } from '../../shared/startup-command-submission'
import { PtyStartupIngress, type PtyIngressEmission } from '../../shared/pty-startup-ingress'
import { resolvePtyOwnerBackend } from '../../shared/pty-owner-backend'
import { resolveProcessExitCause } from '../../shared/terminal-exit-cause'
import { isWindowsGitBashShellPath } from '../git-bash'
import { ShellCommandMarkerScanner } from '../shell-command-marker-scanner'
import { SHELL_INTEGRATION_CONTEXT_ENV } from '../shell-command-marker-template'
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
  ptyShellName,
  ptyTerminalHandle,
  ptyTerminationMode,
  ptyWorktreeId,
  ptyWslDistroById,
  startupIngressByPty
} from './local-pty-provider-state'
import { createLocalPtyShellReadinessSession } from './local-pty-shell-readiness-session'
import { destroyPtyProcess, createPtyPhysicalExit } from './local-pty-termination'
import { writeStartupCommandWhenShellReady } from './local-pty-shell-ready-startup-command'
import type { PtySpawnOptions, PtySpawnResult } from './types'

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
  // Why both: launchAgent is explicit intent that survives command rewrites; recognition catches bare agent command lines.
  if (spawn.launchAgent || plan.startupAgentRecognition) {
    ptyAgentSessionIds.add(id)
  }
  ptyShellName.set(id, getSpawnedShellName(plan.shellPath))
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

  const commandMarkersActive =
    plan.shellReadyLaunch?.supportsCommandMarkers === true ||
    (process.platform === 'win32' &&
      (['wsl.exe', 'pwsh.exe', 'powershell.exe'].includes(
        pathWin32.basename(plan.shellPath).toLowerCase()
      ) ||
        isWindowsGitBashShellPath(plan.shellPath)) &&
      env[SHELL_INTEGRATION_CONTEXT_ENV] !== undefined)
  const commandMarkerScanner = commandMarkersActive
    ? new ShellCommandMarkerScanner(plan.expectedCommandNonce)
    : null
  let commandEpoch = 0
  const emitProviderData = (
    data: string,
    sequenceChars: number,
    transformed: boolean,
    seq?: number
  ): void => {
    if (transformed || sequenceChars !== data.length) {
      getOptions().onData?.(id, data, Date.now(), sequenceChars, true)
    } else {
      getOptions().onData?.(id, data, Date.now())
    }
    for (const cb of dataListeners) {
      cb(
        transformed || sequenceChars !== data.length
          ? { id, data, sequenceChars, ...(seq === undefined ? {} : { seq }), transformed: true }
          : { id, data }
      )
    }
  }
  const emitIngressData = (emission: PtyIngressEmission): void => {
    const sequenceChars = emission.rawEndSeq - emission.rawStartSeq
    if (!commandMarkerScanner || emission.transformed) {
      emitProviderData(
        emission.data,
        sequenceChars,
        emission.transformed || sequenceChars !== emission.data.length,
        emission.rawEndSeq
      )
      return
    }
    let rawCursor = emission.rawStartSeq
    for (const item of commandMarkerScanner.accept(emission.data)) {
      if (item.kind === 'data') {
        rawCursor += item.data.length
        emitProviderData(item.data, item.data.length, false)
        continue
      }
      rawCursor += item.rawLength
      emitProviderData('', item.rawLength, true, rawCursor)
      commandEpoch += 1
      getOptions().onPrivateTerminalFact?.(id, {
        kind: 'command-started',
        agent: item.event.agent,
        trusted: item.event.trusted,
        commandEpoch
      })
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

  // Shell-ready startup command support
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

  const onExitDisposable = proc.onExit(({ exitCode, signal }) => {
    const drainedCommandMarker = commandMarkerScanner?.drain()
    if (drainedCommandMarker && drainedCommandMarker.rawLength > 0) {
      emitProviderData(
        drainedCommandMarker.data,
        drainedCommandMarker.rawLength,
        drainedCommandMarker.transformed,
        startupIngress.acceptedRawSequence
      )
    }
    // Why: node-pty reports a signalled death as {exitCode: 0, signal: N}; the
    // cause is built here, where the signal and the spawn's trustworthiness
    // are both still in hand.
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
    // Why: release the master ptmx fd on natural exit, else a clean exit leaks the fd until GC. See docs/fix-pty-fd-leak.md.
    destroyPtyProcess(proc, { alreadyKilled: wasTerminationRequested })
    ptyReportsChildExitStatus.delete(id)
    getOptions().onExit?.(id, exitCode, incarnationId, cause)
    for (const cb of exitListeners) {
      cb({ id, code: exitCode, incarnationId, cause })
    }
  })
  if (onExitDisposable) {
    ptyExitDisposables.set(id, onExitDisposable)
  }
  ptyDisposables.set(id, disposables)

  if (spawn.command && !plan.startupCommandDeliveredInShellArgs) {
    // Why: shells with bracketed paste armed take a multiline startup prompt literally; others use raw submit.
    const spawnedShellName = getSpawnedShellName(plan.shellPath).toLowerCase()
    const bracketedPasteSafe =
      process.platform !== 'win32' &&
      isBracketedPasteSafeShell({
        shellName: spawnedShellName,
        waitsForShellReady: plan.shellReadyLaunch?.supportsReadyMarker === true
      })
    writeStartupCommandWhenShellReady(
      readiness.shellReadyPromise,
      proc,
      spawn.command,
      (cleanup) => {
        readiness.setStartupCommandCleanup(cleanup)
      },
      { bracketedPasteSafe }
    )
  }

  // Why: publish the OS pid for the memory collector; proc.pid can be briefly 0/undefined before node-pty sees the child.
  const rawPid = proc.pid
  const pid = typeof rawPid === 'number' && Number.isFinite(rawPid) && rawPid > 0 ? rawPid : null
  return {
    id,
    incarnationId,
    pid,
    ...(spawnedWslDistro !== undefined ? { wslDistro: spawnedWslDistro } : {})
  }
}
