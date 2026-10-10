import type * as pty from 'node-pty'
import type { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import { readPtySlavePath } from '../../shared/pty-slave-line-discipline-echo'
import {
  createShellPromptReadinessProbe,
  type ShellPromptReadinessProbe
} from '../shell-prompt-readiness-probe'
import {
  createShellStartupOutputScanState,
  drainShellStartupOutputScanState,
  scanShellStartupOutput
} from '../shell-startup-output-scanner'
import type { LocalPtyLaunchPlan } from './local-pty-launch-plan'
import { ptyCleanupCallbacks } from './local-pty-provider-state'
import {
  STARTUP_COMMAND_READY_MAX_WAIT_MS,
  type ShellReadySignal
} from './local-pty-shell-ready-startup-command'
import type { PtySpawnOptions } from './types'

export type LocalPtyShellReadinessSession = {
  shellReadyPromise: Promise<ShellReadySignal>
  acceptData(rawData: string): void
  setStartupCommandCleanup(cleanup: () => void): void
  prepareForExit(): void
}

export function createLocalPtyShellReadinessSession(args: {
  id: string
  spawn: PtySpawnOptions
  plan: LocalPtyLaunchPlan
  env: Record<string, string>
  proc: pty.IPty
  startupIngress: PtyStartupIngress
}): LocalPtyShellReadinessSession {
  const { id, spawn, plan, env, proc, startupIngress } = args
  let resolveShellReady: ((signal: ShellReadySignal) => void) | null = null
  let shellReadyTimeout: ReturnType<typeof setTimeout> | null = null
  let shellStartupPid: number | null = null
  let shellPromptReadinessProbe: ShellPromptReadinessProbe | null = null
  let shellStartupOutputScanState = plan.shellReadyLaunch?.supportsReadyMarker
    ? createShellStartupOutputScanState()
    : null
  const shellReadyPromise = spawn.command
    ? new Promise<ShellReadySignal>((resolve) => {
        resolveShellReady = resolve
      })
    : Promise.resolve({ postMarkerBytesObserved: false })
  const finishShellReady = (signal: ShellReadySignal): void => {
    if (!resolveShellReady) {
      return
    }
    if (shellReadyTimeout) {
      clearTimeout(shellReadyTimeout)
      shellReadyTimeout = null
    }
    shellPromptReadinessProbe?.dispose()
    shellPromptReadinessProbe = null
    const resolve = resolveShellReady
    resolveShellReady = null
    resolve(signal)
  }
  const releaseHeldShellReadyBytes = (): void => {
    if (!shellStartupOutputScanState) {
      return
    }
    const heldBytes = drainShellStartupOutputScanState(shellStartupOutputScanState)
    shellStartupOutputScanState = null
    if (heldBytes.length === 0) {
      return
    }
    startupIngress.accept(heldBytes)
  }
  if (shellStartupOutputScanState) {
    shellPromptReadinessProbe = createShellPromptReadinessProbe({
      slavePath: readPtySlavePath(proc),
      shellPath: plan.shellPath,
      shellCwd: plan.effectiveCwd,
      shellPathEnv: env.PATH,
      getShellPid: () => shellStartupPid,
      onPromptReady: () => {
        console.warn(
          `[pty] ${id}: shell-ready wrapper was replaced before its marker; releasing at the identified shell prompt. OSC 133 integration may be unavailable.`
        )
        releaseHeldShellReadyBytes()
        finishShellReady({ postMarkerBytesObserved: true })
      }
    })
  }
  if (spawn.command) {
    if (plan.shellReadyLaunch?.supportsReadyMarker) {
      shellReadyTimeout = setTimeout(() => {
        releaseHeldShellReadyBytes()
        finishShellReady({ postMarkerBytesObserved: false })
      }, STARTUP_COMMAND_READY_MAX_WAIT_MS)
    } else {
      finishShellReady({ postMarkerBytesObserved: false })
    }
  }
  let startupCommandCleanup: (() => void) | null = null
  if (spawn.command) {
    ptyCleanupCallbacks.set(id, () => {
      if (shellReadyTimeout) {
        clearTimeout(shellReadyTimeout)
        shellReadyTimeout = null
      }
      releaseHeldShellReadyBytes()
      startupCommandCleanup?.()
      startupCommandCleanup = null
      resolveShellReady = null
      shellPromptReadinessProbe?.dispose()
      shellPromptReadinessProbe = null
    })
  }

  return {
    shellReadyPromise,
    acceptData: (rawData) => {
      let data = rawData
      if (shellStartupOutputScanState && resolveShellReady) {
        const scanned = scanShellStartupOutput(shellStartupOutputScanState, data)
        data = scanned.output
        if (scanned.shellPid) {
          shellStartupPid = scanned.shellPid
        }
        if (scanned.ready) {
          finishShellReady({ postMarkerBytesObserved: scanned.postMarkerBytesObserved })
        }
      }
      startupIngress.accept(data)
      if (resolveShellReady && data.length > 0) {
        shellPromptReadinessProbe?.notifyOutput(data)
      }
    },
    setStartupCommandCleanup: (cleanup) => {
      startupCommandCleanup = cleanup
    },
    prepareForExit: () => {
      if (shellReadyTimeout) {
        clearTimeout(shellReadyTimeout)
        shellReadyTimeout = null
      }
      startupCommandCleanup?.()
      shellPromptReadinessProbe?.dispose()
      shellPromptReadinessProbe = null
    }
  }
}
