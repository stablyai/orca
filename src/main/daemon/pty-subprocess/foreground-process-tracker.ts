import type * as pty from 'node-pty'
import { getAgentForegroundContextPaths } from '../../providers/agent-foreground-context-paths'
import { resolveAgentForegroundProcessWithAvailability } from '../../providers/agent-foreground-process'
import { confirmPtyShellForeground } from './pty-shell-foreground-confirmation'
import { readWindowsConsoleAttachedProcessIds } from '../../providers/windows-console-attached-processes'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess,
  type RecognizedAgentProcess
} from '../../../shared/agent-process-recognition'
import {
  shouldInspectOuterWrapperForegroundName,
  shouldInspectOuterWrapperForegroundProcess
} from '../../../shared/foreground-wrapper-agent'
import { isShellProcess } from '../../../shared/shell-process-detection'
import { resolveFallbackForegroundProcess } from './foreground-fallback-process'
import { parsePtySessionId } from '../pty-session-id'
import type { ForegroundProcessObservation } from '../session-subprocess-handle'
import {
  createForegroundIdentityRefresh,
  FOREGROUND_AGENT_CACHE_TTL_MS,
  agentEvidenceOutdatesScan,
  getActiveStartupAgent,
  isShellTitleCorroborated,
  type ForegroundIdentityState
} from './foreground-identity-refresh'

const STARTUP_AGENT_FOREGROUND_BOOTSTRAP_MS = 5_000

export type PtyForegroundProcessTracker = {
  recordOutput(data: string): void
  markDead(): void
  getForegroundProcess(): string | null
  observeForegroundProcess(): ForegroundProcessObservation
  confirmForegroundProcess(): Promise<string | null>
  confirmShellForeground(): Promise<boolean>
}

export function createPtyForegroundProcessTracker(args: {
  process: pty.IPty
  shellPath: string
  cwd?: string
  sessionId: string
  startupAgentRecognition: RecognizedAgentProcess | null
  isDead: () => boolean
}): PtyForegroundProcessTracker {
  const proc = args.process
  const contextPaths = getAgentForegroundContextPaths({
    cwd: args.cwd,
    worktreeId: parsePtySessionId(args.sessionId).worktreeId
  })
  const state: ForegroundIdentityState = {
    cachedAgentForeground: null,
    startupAgentForeground: args.startupAgentRecognition
      ? {
          processName: args.startupAgentRecognition.processName,
          expiresAt: Date.now() + STARTUP_AGENT_FOREGROUND_BOOTSTRAP_MS
        }
      : null,
    lastScanSettlement: null,
    refreshInFlight: false,
    lastRefreshStartedAt: 0,
    lastOutputAt: 0
  }
  const getFallbackProcess = (): string | null =>
    resolveFallbackForegroundProcess(proc.process, args.shellPath)
  const shouldInspectFallback = (fallbackProcess: string | null): boolean =>
    fallbackProcess !== null &&
    (isShellProcess(fallbackProcess) ||
      isAgentForegroundWrapperProcess(fallbackProcess) ||
      shouldInspectOuterWrapperForegroundName(fallbackProcess) ||
      process.platform !== 'win32')
  const scheduleRefresh = createForegroundIdentityRefresh({
    process: proc,
    state,
    contextPaths,
    isDead: args.isDead,
    getFallbackProcess,
    shouldInspectFallback
  })

  const observed = (processName: string | null): ForegroundProcessObservation => ({
    processName,
    evidence: { verdict: 'observed', processName }
  })
  const unverifiable = (
    processName: string | null,
    reason: string
  ): ForegroundProcessObservation => ({
    processName,
    evidence: { verdict: 'unverifiable', reason }
  })

  const observeForegroundProcess = (): ForegroundProcessObservation => {
    if (args.isDead()) {
      // The pty's own exit marked death: a host observation, not a failed read.
      return observed(null)
    }
    try {
      const fallbackProcess = getFallbackProcess()
      const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
      const inspectOuterWrapper =
        fallbackRecognition !== null &&
        shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)
      if (fallbackProcess && fallbackRecognition && !inspectOuterWrapper) {
        state.cachedAgentForeground = {
          processName: fallbackProcess,
          pid: null,
          refreshedAt: Date.now()
        }
        state.startupAgentForeground = null
        return observed(fallbackProcess)
      }
      scheduleRefresh(fallbackProcess)
      const now = Date.now()
      if (
        state.cachedAgentForeground &&
        now - state.cachedAgentForeground.refreshedAt <= FOREGROUND_AGENT_CACHE_TTL_MS
      ) {
        return observed(state.cachedAgentForeground.processName)
      }
      if (
        state.cachedAgentForeground &&
        fallbackProcess !== null &&
        (isAgentForegroundWrapperProcess(fallbackProcess) ||
          inspectOuterWrapper ||
          (process.platform === 'win32' && isShellProcess(fallbackProcess)))
      ) {
        return observed(state.cachedAgentForeground.processName)
      }
      const activeStartupAgentForeground = getActiveStartupAgent(state, now)
      if (fallbackProcess && isShellProcess(fallbackProcess) && activeStartupAgentForeground) {
        return observed(activeStartupAgentForeground.processName)
      }
      if (fallbackProcess === null) {
        // A successful read that named nothing usable observed nothing.
        return unverifiable(null, 'pty reported no usable foreground title')
      }
      if (
        isShellProcess(fallbackProcess) &&
        !isShellTitleCorroborated(state.lastScanSettlement, now, state.cachedAgentForeground)
      ) {
        return unverifiable(fallbackProcess, 'shell title without a corroborating foreground scan')
      }
      return observed(fallbackProcess)
    } catch {
      return unverifiable(null, 'foreground title read threw')
    }
  }

  return {
    recordOutput: (data) => {
      if (data.length > 0) {
        state.lastOutputAt = Date.now()
      }
    },
    markDead: () => {
      state.cachedAgentForeground = null
      state.startupAgentForeground = null
    },
    getForegroundProcess: () => observeForegroundProcess().processName,
    observeForegroundProcess,
    confirmForegroundProcess: async () => {
      if (args.isDead() || !proc.pid) {
        return null
      }
      try {
        const fallbackProcess = getFallbackProcess()
        const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
        if (
          !fallbackProcess ||
          (fallbackRecognition !== null &&
            process.platform !== 'win32' &&
            !shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)) ||
          (process.platform !== 'win32' && !shouldInspectFallback(fallbackProcess))
        ) {
          return fallbackProcess
        }
        // Why stamped before the call: the POSIX table is a process-wide cache, so this answer
        // can come from a scan another pane started. Replaced by the measured scan start when
        // the resolver reports one; this is only the floor for the Windows path, which has none.
        const scanRequestedAt = Date.now()
        const resolution = await resolveAgentForegroundProcessWithAvailability(
          proc.pid,
          fallbackProcess,
          {
            contextPaths,
            fresh: true,
            ...(process.platform === 'win32'
              ? {
                  forceProcessScan: true,
                  readWindowsConsoleAttachedProcessIds: () =>
                    readWindowsConsoleAttachedProcessIds(proc.pid)
                }
              : {})
          }
        )
        if (args.isDead() || !resolution.available) {
          return null
        }
        const recognized = recognizeAgentProcess(resolution.processName)
        if (recognized) {
          state.cachedAgentForeground = {
            processName: recognized.processName,
            pid: resolution.processId ?? null,
            refreshedAt: Date.now()
          }
          state.startupAgentForeground = null
          return recognized.processName
        }
        // An agent recognized while this scan was in flight is evidence the scan's table could
        // not have held, so this answer may not retire it — and retiring it would also strip the
        // shell-title corroboration gate of the very evidence that holds it closed.
        if (
          !agentEvidenceOutdatesScan(
            state.cachedAgentForeground,
            resolution.tableScanStartedAtMs ?? scanRequestedAt
          )
        ) {
          state.cachedAgentForeground = null
          state.startupAgentForeground = null
        }
        return resolution.processName
      } catch {
        return null
      }
    },
    confirmShellForeground: () =>
      confirmPtyShellForeground({ process: proc, shellPath: args.shellPath, isDead: args.isDead })
  }
}
