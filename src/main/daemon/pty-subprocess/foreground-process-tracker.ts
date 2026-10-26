import type * as pty from 'node-pty'
import { ptyShellProcessId } from '../../windows/windows-pty-job'
import { getAgentForegroundContextPaths } from '../../providers/agent-foreground-context-paths'
import { confirmPtyShellForeground } from './pty-shell-foreground-confirmation'
import {
  judgeCachedAgentJobEvidence,
  WINDOWS_DETACHED_DESCENDANT_IDENTITY_MAX_AGE_MS
} from '../../providers/windows-cached-agent-revalidation'
import {
  isWindowsPtyJobReadable,
  readWindowsPtyJobProcessIds
} from '../../providers/windows-pty-job-membership'

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
import { parsePtySessionId } from '../../../shared/pty-session-id-format'
import {
  ptyProcessNameIsSpawnFile,
  createPtyForegroundResolver,
  shouldCachePtyForeground
} from './spawn-file-foreground-process'

const FOREGROUND_AGENT_CACHE_TTL_MS = 1000
const SHELL_FOREGROUND_REFRESH_RETRY_MS = 5_000
const WINDOWS_IDLE_SHELL_FOREGROUND_REFRESH_RETRY_MS = 15_000
const SHELL_FOREGROUND_OUTPUT_HOT_WINDOW_MS = 10_000
const STARTUP_AGENT_FOREGROUND_BOOTSTRAP_MS = 5_000

type CachedAgentForeground = { processName: string; pid: number | null; refreshedAt: number }

export type PtyForegroundProcessTracker = {
  recordOutput(data: string): void
  markDead(): void
  /** rawFallback bypasses cached identity and process-table refreshes for cheap polling. */
  getForegroundProcess(options?: { rawFallback?: boolean; cachedOnly?: boolean }): string | null
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
  const staticName = ptyProcessNameIsSpawnFile(proc)
  const resolveForeground = createPtyForegroundResolver(proc)
  let lastOutputAt = 0
  // `pid` anchors the identity to the row that proved it (null when ambiguous).
  let cachedAgentForeground: CachedAgentForeground | null = null
  const contextPaths = getAgentForegroundContextPaths({
    cwd: args.cwd,
    worktreeId: parsePtySessionId(args.sessionId).worktreeId
  })
  let startupAgentForeground: { processName: string; expiresAt: number } | null =
    args.startupAgentRecognition
      ? {
          processName: args.startupAgentRecognition.processName,
          expiresAt: Date.now() + STARTUP_AGENT_FOREGROUND_BOOTSTRAP_MS
        }
      : null
  let foregroundRefreshInFlight = false
  let lastForegroundRefreshStartedAt = 0
  const cacheAgentForeground = (processName: string, pid: number | null): void => {
    cachedAgentForeground = { processName, pid, refreshedAt: Date.now() }
    startupAgentForeground = null
  }
  const getFallbackProcess = (): string | null =>
    resolveFallbackForegroundProcess(staticName ? args.shellPath : proc.process, args.shellPath)
  const getActiveStartupAgent = (
    now = Date.now()
  ): { processName: string; expiresAt: number } | null => {
    if (startupAgentForeground && now > startupAgentForeground.expiresAt) {
      startupAgentForeground = null
    }
    return startupAgentForeground
  }
  const shouldInspectFallback = (fallbackProcess: string | null): boolean =>
    fallbackProcess !== null &&
    (isShellProcess(fallbackProcess) ||
      isAgentForegroundWrapperProcess(fallbackProcess) ||
      shouldInspectOuterWrapperForegroundName(fallbackProcess) ||
      process.platform !== 'win32')

  const scheduleRefresh = (fallbackProcess: string | null): void => {
    if (args.isDead() || !proc.pid) {
      return
    }
    const fallbackIsShell = fallbackProcess !== null && isShellProcess(fallbackProcess)
    const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
    if (
      !fallbackProcess ||
      (fallbackRecognition !== null &&
        !shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)) ||
      !shouldInspectFallback(fallbackProcess)
    ) {
      return
    }
    const now = Date.now()
    const idleNoEvidenceShell =
      fallbackIsShell && !getActiveStartupAgent(now) && !cachedAgentForeground
    const retryMs = !idleNoEvidenceShell
      ? FOREGROUND_AGENT_CACHE_TTL_MS
      : process.platform === 'win32' && now - lastOutputAt > SHELL_FOREGROUND_OUTPUT_HOT_WINDOW_MS
        ? WINDOWS_IDLE_SHELL_FOREGROUND_REFRESH_RETRY_MS
        : SHELL_FOREGROUND_REFRESH_RETRY_MS
    if (foregroundRefreshInFlight || now - lastForegroundRefreshStartedAt < retryMs) {
      return
    }
    foregroundRefreshInFlight = true
    lastForegroundRefreshStartedAt = now
    const identityOlderThan = (ms: number): boolean =>
      cachedAgentForeground !== null && Date.now() - cachedAgentForeground.refreshedAt > ms
    const retireStaleForegroundIdentity = ({ onlyWhenAged = false } = {}): void => {
      const currentFallbackProcess = getFallbackProcess()
      if (
        fallbackIsShell &&
        !getActiveStartupAgent() &&
        currentFallbackProcess !== null &&
        isShellProcess(currentFallbackProcess) &&
        (!onlyWhenAged || identityOlderThan(WINDOWS_DETACHED_DESCENDANT_IDENTITY_MAX_AGE_MS))
      ) {
        cachedAgentForeground = null
        startupAgentForeground = null
      } else if (
        identityOlderThan(FOREGROUND_AGENT_CACHE_TTL_MS) &&
        currentFallbackProcess !== null &&
        isAgentForegroundWrapperProcess(currentFallbackProcess)
      ) {
        cachedAgentForeground = null
      }
    }
    const anchor = cachedAgentForeground
    void resolveForeground(proc.pid, fallbackProcess, {
      contextPaths,
      ...(anchor?.pid != null
        ? { anchorProcessId: anchor.pid, anchorProcessName: anchor.processName }
        : {})
    })
      .then<string | void>(({ processName, processId, available, anchorPidForeign }) => {
        if (args.isDead() || !available) {
          return
        }
        if (!shouldCachePtyForeground(processName, staticName)) {
          if (process.platform === 'win32' && fallbackIsShell && cachedAgentForeground !== null) {
            // Job membership avoids attaching to the console or forking a helper.
            const verdict = judgeCachedAgentJobEvidence({
              jobProcessIds: readWindowsPtyJobProcessIds(proc),
              jobSupported: isWindowsPtyJobReadable(),
              shellPid: ptyShellProcessId(proc) ?? proc.pid,
              anchorProcessId: cachedAgentForeground.pid,
              identityAgeMs: Date.now() - cachedAgentForeground.refreshedAt
            })
            // Unavailable evidence cannot prove exit.
            if (verdict === 'unavailable') {
              return
            }
            if (verdict === 'unsupported') {
              // Without job support, use the available scan that found no agent.
              retireStaleForegroundIdentity()
              return
            }
            if (verdict === 'confirmed' || verdict === 'recheck') {
              if (anchorPidForeign === true) {
                retireStaleForegroundIdentity()
                return
              }
              // Keep an anchored identity while its PID remains in the job and no foreign identity was found.
              cachedAgentForeground = { ...cachedAgentForeground, refreshedAt: Date.now() }
              return
            }
            if (verdict === 'exited' || verdict === 'anchor-exited') {
              // Retire only after an available scan found no agent.
              retireStaleForegroundIdentity()
              return
            }
            // Unanchored job members may be detached leftovers; bound the cached identity’s age.
            retireStaleForegroundIdentity({ onlyWhenAged: true })
            return
          }
          retireStaleForegroundIdentity()
          return
        }
        cachedAgentForeground = { processName, pid: processId ?? null, refreshedAt: Date.now() }
        startupAgentForeground = null
        return processName
      })
      .catch(() => {
        // Best-effort only: foreground enrichment must never affect PTY health.
      })
      .finally(() => {
        foregroundRefreshInFlight = false
      })
  }

  return {
    recordOutput: (data) => {
      if (data.length > 0) {
        lastOutputAt = Date.now()
      }
    },
    markDead: () => {
      cachedAgentForeground = null
      startupAgentForeground = null
    },
    getForegroundProcess: (options) => {
      if (args.isDead()) {
        return null
      }
      if (options?.cachedOnly === true) {
        return cachedAgentForeground &&
          Date.now() - cachedAgentForeground.refreshedAt <= FOREGROUND_AGENT_CACHE_TTL_MS
          ? cachedAgentForeground.processName
          : null
      }
      if (options?.rawFallback === true) {
        return getFallbackProcess()
      }
      try {
        const fallbackProcess = getFallbackProcess()
        const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
        const inspectOuterWrapper =
          fallbackRecognition !== null &&
          shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)
        if (fallbackProcess && fallbackRecognition && !inspectOuterWrapper) {
          cacheAgentForeground(fallbackProcess, null)
          return fallbackProcess
        }
        scheduleRefresh(fallbackProcess)
        const now = Date.now()
        if (
          cachedAgentForeground &&
          now - cachedAgentForeground.refreshedAt <= FOREGROUND_AGENT_CACHE_TTL_MS
        ) {
          return cachedAgentForeground.processName
        }
        if (
          cachedAgentForeground &&
          fallbackProcess !== null &&
          (staticName ||
            isAgentForegroundWrapperProcess(fallbackProcess) ||
            inspectOuterWrapper ||
            (process.platform === 'win32' && isShellProcess(fallbackProcess)))
        ) {
          return cachedAgentForeground.processName
        }
        const activeStartupAgentForeground = getActiveStartupAgent(now)
        if (fallbackProcess && isShellProcess(fallbackProcess) && activeStartupAgentForeground) {
          return activeStartupAgentForeground.processName
        }
        return fallbackProcess
      } catch {
        return null
      }
    },
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
        const resolution = await resolveForeground(proc.pid, fallbackProcess, {
          contextPaths,
          fresh: true,
          ...(process.platform === 'win32'
            ? {
                forceProcessScan: true,
                readWindowsConsoleAttachedProcessIds: () =>
                  readWindowsConsoleAttachedProcessIds(proc.pid)
              }
            : {})
        })
        if (args.isDead() || !resolution.available) {
          return null
        }
        const processName =
          recognizeAgentProcess(resolution.processName)?.processName ?? resolution.processName
        if (shouldCachePtyForeground(processName, staticName)) {
          cacheAgentForeground(processName, resolution.processId ?? null)
          return processName
        }
        cachedAgentForeground = null
        startupAgentForeground = null
        return resolution.processName
      } catch {
        return null
      }
    },
    confirmShellForeground: () =>
      confirmPtyShellForeground({ process: proc, shellPath: args.shellPath, isDead: args.isDead })
  }
}
