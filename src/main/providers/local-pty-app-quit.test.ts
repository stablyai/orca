import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { IPty } from 'node-pty'
import type { LocalPtyLaunchPlan } from './local-pty-launch-plan'
import { activateLocalPtySession } from './local-pty-session-activation'
import { killAllLocalPtys } from './local-pty-termination'
import {
  clearPtyState,
  exitListeners,
  ptyCleanupCallbacks,
  ptyProcesses,
  startupIngressByPty
} from './local-pty-provider-state'
import { DESCENDANT_KILL_GRACE_MS, type ProcessTableRow } from '../pty-descendant-termination'
import {
  SHUTDOWN_DESCENDANT_TABLE_TIMEOUT_MS,
  SHUTDOWN_DESCENDANT_VERIFY_MS
} from '../daemon/immediate-kill-reply-budget'

type ProcessTableCallback = (error: Error | null, stdout: string) => void
const { execFile } = vi.hoisted(() => ({
  execFile:
    vi.fn<
      (file: string, args: string[], options: unknown, callback: ProcessTableCallback) => void
    >()
}))

// Keep the sweep and bounded verifier real, replacing only OS reads and signals.
vi.mock('node:child_process', () => ({ execFile }))
vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: vi.fn(),
  runProcessSync: () => ({ code: 0, stdout: '12345 12345 ? S' })
}))
vi.mock('../windows-process-tree-kill', () => ({ terminateWindowsProcessTree: vi.fn() }))
vi.mock('../windows-pty-root-identity', () => ({ verifyWindowsTreeKillTarget: vi.fn() }))
vi.mock('../windows/windows-pty-job', () => ({ terminatePtyJob: () => 'unavailable' }))
vi.mock('./local-pty-launch-helpers', () => ({
  getSpawnedShellName: () => 'sh',
  normalizeLocalCallerSessionId: (id: string | undefined) => id
}))
vi.mock('./local-pty-shell-readiness-session', () => ({
  createLocalPtyShellReadinessSession: () => ({
    shellReadyPromise: Promise.resolve({ postMarkerBytesObserved: false }),
    acceptData: vi.fn(),
    prepareForExit: vi.fn()
  })
}))

const ROOT_PID = 12345
const CHILD_PID = 12346
const STARTED_AT = 'Thu Oct 01 02:00:00 2026'
const ROOT: ProcessTableRow = {
  pid: ROOT_PID,
  ppid: 1,
  pgid: ROOT_PID,
  startedAt: STARTED_AT
}
// A setsid child has left the root's process group but remains in its parent tree.
const DETACHED_CHILD: ProcessTableRow = {
  pid: CHILD_PID,
  ppid: ROOT_PID,
  pgid: CHILD_PID,
  startedAt: STARTED_AT
}
const PLAN: LocalPtyLaunchPlan = {
  startupAgentRecognition: null,
  defaultCwd: '/tmp',
  cwd: '/tmp',
  wslInfo: null,
  worktreeWslContext: undefined,
  preferredWslContext: undefined,
  launchWslContext: undefined,
  shellPath: '/bin/sh',
  shellArgs: [],
  effectiveCwd: '/tmp',
  validationCwd: '/tmp',
  startupCommandDeliveredInShellArgs: false,
  windowsFallbackAttempts: [],
  shellReadyLaunch: null,
  getFallbackShellReadyConfig: undefined,
  primaryLaunchEnvKeys: [],
  isWslShell: false,
  launchWslDistro: null
}

function serializeRows(rows: ProcessTableRow[]): string {
  return rows.map((row) => `${row.pid} ${row.ppid} ${row.pgid} ${row.startedAt}`).join('\n')
}

function activateSession(agent = true) {
  let exitCallback: ((info: { exitCode: number; signal?: number }) => void) | undefined
  const onExit = vi.fn()
  const disposeData = vi.fn()
  const destroy = vi.fn()
  const listener = vi.fn()
  const kill = vi.fn(() => exitCallback?.({ exitCode: 0, signal: 9 }))
  const proc: IPty & { destroy(): void } = {
    pid: ROOT_PID,
    process: 'sh',
    cols: 80,
    rows: 24,
    handleFlowControl: false,
    onData: () => ({ dispose: disposeData }),
    onExit: (callback) => {
      exitCallback = callback
      return {
        dispose: () => {
          exitCallback = undefined
        }
      }
    },
    write() {},
    clear() {},
    pause() {},
    resume() {},
    resize() {},
    kill,
    destroy
  }
  exitListeners.add(listener)
  activateLocalPtySession({
    id: 'app-quit-session',
    incarnationId: 'app-quit-incarnation',
    spawn: { cols: 80, rows: 24, ...(agent ? { launchAgent: 'claude' as const } : {}) },
    getOptions: () => ({ onExit }),
    plan: PLAN,
    env: {},
    proc,
    reportsChildExitStatus: true,
    spawnedWslDistro: undefined
  })
  return {
    proc,
    kill,
    destroy,
    onExit,
    listener,
    disposeData,
    exit: () => exitCallback?.({ exitCode: 0 })
  }
}

describe('local PTY app-quit descendant completion', () => {
  let originalPlatform: PropertyDescriptor | undefined
  let rows: ProcessTableRow[]
  let pendingTableCallbacks: ProcessTableCallback[]
  let sendSignal: MockInstance<typeof process.kill>

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 1, 2, 30))
    rows = [ROOT, DETACHED_CHILD]
    pendingTableCallbacks = []
    execFile.mockReset()
    execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, serializeRows(rows))
    })
    sendSignal = vi.spyOn(process, 'kill').mockReturnValue(true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    for (const callback of pendingTableCallbacks) {
      callback(new Error('test process-table read released'), '')
    }
    for (const id of ptyProcesses.keys()) {
      clearPtyState(id)
    }
    for (const ingress of startupIngressByPty.values()) {
      ingress.drainAndClose()
    }
    startupIngressByPty.clear()
    exitListeners.clear()
    // Expire the shutdown verifier's shared 25ms table capture between cases.
    await vi.advanceTimersByTimeAsync(25)
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('waits for SIGKILL and verified absence before killing the agent root or finishing quit', async () => {
    const session = activateSession()
    let settled = false
    const shutdown = killAllLocalPtys().then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(sendSignal.mock.calls).toEqual([[CHILD_PID, 'SIGTERM']])
    expect(session.kill).not.toHaveBeenCalled()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(DESCENDANT_KILL_GRACE_MS - 1)
    expect(sendSignal).not.toHaveBeenCalledWith(CHILD_PID, 'SIGKILL')
    expect(session.kill).not.toHaveBeenCalled()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(sendSignal.mock.calls).toEqual([
      [CHILD_PID, 'SIGTERM'],
      [CHILD_PID, 'SIGKILL']
    ])
    expect(session.kill).not.toHaveBeenCalled()
    expect(settled).toBe(false)

    rows = [ROOT]
    await vi.advanceTimersByTimeAsync(50)
    expect(settled).toBe(false)
    expect(session.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50)
    await shutdown

    expect(session.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(session.onExit).not.toHaveBeenCalled()
    expect(session.listener).not.toHaveBeenCalled()
    expect(ptyProcesses.size).toBe(0)
    await vi.advanceTimersByTimeAsync(25)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('joins unfinished descendant cleanup when another quit arrives after the root exits', async () => {
    const session = activateSession()
    let firstSettled = false
    let secondSettled = false
    const first = killAllLocalPtys().then(() => {
      firstSettled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(sendSignal).toHaveBeenCalledWith(CHILD_PID, 'SIGTERM')

    session.exit()
    rows = [{ ...DETACHED_CHILD, ppid: 1 }]
    expect(ptyProcesses.size).toBe(0)
    const second = killAllLocalPtys().then(() => {
      secondSettled = true
    })
    await vi.advanceTimersByTimeAsync(DESCENDANT_KILL_GRACE_MS - 1)
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)
    expect(sendSignal).not.toHaveBeenCalledWith(CHILD_PID, 'SIGKILL')

    await vi.advanceTimersByTimeAsync(1)
    expect(sendSignal.mock.calls).toEqual([
      [CHILD_PID, 'SIGTERM'],
      [CHILD_PID, 'SIGKILL']
    ])
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)
    rows = []
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([first, second])

    expect(firstSettled).toBe(true)
    expect(secondSettled).toBe(true)
    expect(session.kill).not.toHaveBeenCalled()
    expect(session.onExit).not.toHaveBeenCalled()
    expect(session.listener).not.toHaveBeenCalled()
    expect(sendSignal).toHaveBeenCalledTimes(2)
  })

  it('does not force-kill a PID recycled after the TERM request', async () => {
    const session = activateSession()
    const shutdown = killAllLocalPtys()
    await vi.advanceTimersByTimeAsync(0)
    expect(sendSignal).toHaveBeenCalledWith(CHILD_PID, 'SIGTERM')

    rows = [ROOT, { ...DETACHED_CHILD, ppid: 1, startedAt: 'Thu Oct 01 02:30:00 2026' }]
    await vi.advanceTimersByTimeAsync(100)
    await shutdown
    await vi.advanceTimersByTimeAsync(DESCENDANT_KILL_GRACE_MS)

    expect(sendSignal.mock.calls).toEqual([[CHILD_PID, 'SIGTERM']])
    expect(session.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['unreadable', 'hung', 'duplicate'] as const)(
    'bounds app quit without force-killing an identity from a %s verification table',
    async (failure) => {
      const session = activateSession()
      let settled = false
      const shutdown = killAllLocalPtys().then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(sendSignal).toHaveBeenCalledWith(CHILD_PID, 'SIGTERM')

      if (failure === 'duplicate') {
        rows = [ROOT, DETACHED_CHILD, { ...DETACHED_CHILD, ppid: 1 }]
      } else {
        execFile.mockImplementation((_file, _args, _options, callback) => {
          if (failure === 'unreadable') {
            callback(new Error('process table unavailable'), '')
          } else {
            pendingTableCallbacks.push(callback)
          }
        })
      }
      await vi.advanceTimersByTimeAsync(DESCENDANT_KILL_GRACE_MS)
      expect(settled).toBe(false)
      expect(session.kill).not.toHaveBeenCalled()
      expect(sendSignal).not.toHaveBeenCalledWith(CHILD_PID, 'SIGKILL')

      await vi.advanceTimersByTimeAsync(
        SHUTDOWN_DESCENDANT_VERIFY_MS + 2 * SHUTDOWN_DESCENDANT_TABLE_TIMEOUT_MS
      )
      await shutdown
      expect(session.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
      expect(sendSignal.mock.calls).toEqual([[CHILD_PID, 'SIGTERM']])
      expect(console.warn).toHaveBeenCalledWith('[pty] app-quit descendant cleanup incomplete', {
        id: 'app-quit-session',
        verdict: 'unverifiable'
      })
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('cancels startup delivery and data listeners before awaiting the descendant snapshot', async () => {
    const session = activateSession()
    const deliverStartupCommand = vi.fn()
    const timer = setTimeout(deliverStartupCommand, 50)
    const cleanupStartup = vi.fn(() => clearTimeout(timer))
    ptyCleanupCallbacks.set('app-quit-session', cleanupStartup)
    let finishCapture: ProcessTableCallback | undefined
    execFile.mockImplementationOnce((_file, _args, _options, callback) => {
      finishCapture = callback
    })

    const shutdown = killAllLocalPtys()
    expect(cleanupStartup).toHaveBeenCalledOnce()
    expect(session.disposeData).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(50)
    expect(deliverStartupCommand).not.toHaveBeenCalled()
    expect(session.kill).not.toHaveBeenCalled()
    expect(finishCapture).toBeDefined()

    finishCapture?.(null, serializeRows([ROOT]))
    await shutdown
    expect(session.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(ptyProcesses.size).toBe(0)
  })

  it('suppresses a late root exit while its descendant snapshot is still in flight', async () => {
    const session = activateSession()
    let finishCapture: ProcessTableCallback | undefined
    execFile.mockImplementationOnce((_file, _args, _options, callback) => {
      finishCapture = callback
    })
    const shutdown = killAllLocalPtys()
    await vi.advanceTimersByTimeAsync(0)
    expect(finishCapture).toBeDefined()

    session.exit()
    finishCapture?.(null, serializeRows(rows))
    await shutdown

    expect(session.onExit).not.toHaveBeenCalled()
    expect(session.listener).not.toHaveBeenCalled()
    expect(sendSignal).not.toHaveBeenCalled()
    expect(session.kill).not.toHaveBeenCalled()
    expect(ptyProcesses.size).toBe(0)
  })

  it('disposes the POSIX handle and callbacks even when the root force signal fails', async () => {
    rows = [ROOT]
    const session = activateSession()
    session.kill.mockImplementation(() => {
      throw new Error('root signal rejected')
    })
    const deliverStartupCommand = vi.fn()
    const timer = setTimeout(deliverStartupCommand, 50)
    ptyCleanupCallbacks.set('app-quit-session', () => clearTimeout(timer))

    await killAllLocalPtys()
    session.exit()
    expect(() => session.proc.kill()).not.toThrow()
    await vi.advanceTimersByTimeAsync(50)

    expect(session.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(session.destroy).toHaveBeenCalledOnce()
    expect(session.disposeData).toHaveBeenCalledOnce()
    expect(deliverStartupCommand).not.toHaveBeenCalled()
    expect(session.onExit).not.toHaveBeenCalled()
    expect(session.listener).not.toHaveBeenCalled()
    expect(ptyProcesses.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves plain POSIX shell quit without a descendant sweep', async () => {
    const session = activateSession(false)
    await killAllLocalPtys()

    expect(session.kill).toHaveBeenCalledExactlyOnceWith()
    expect(execFile).not.toHaveBeenCalled()
    expect(sendSignal).not.toHaveBeenCalled()
    expect(session.onExit).not.toHaveBeenCalled()
    expect(session.listener).not.toHaveBeenCalled()
    expect(ptyProcesses.size).toBe(0)
  })
})
