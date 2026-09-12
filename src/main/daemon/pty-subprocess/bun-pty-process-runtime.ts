import {
  assignCurrentProcessToBunPtyHostJob,
  createWindowsBunPtyJob,
  type WindowsBunPtyJob
} from './windows-bun-pty-job'
import { createWindowsBunPtyLaunch, type WindowsBunPtyLaunch } from './windows-bun-pty-launch'
import type { BunPtyProcess, BunSubprocess, SpawnBunPtyDeps } from './bun-pty-process-contract'
import { resolveBunRuntime } from './bun-pty-process-capabilities'
import { createBunPtyProducerFlowControl } from './bun-pty-process-flow-control'

export function spawnBunPty(
  args: {
    file: string
    args: string[]
    cwd: string
    env: Record<string, string>
    cols: number
    rows: number
  },
  deps: SpawnBunPtyDeps = {}
): BunPtyProcess {
  const runtime = resolveBunRuntime(deps.runtime)

  const platform = deps.platform ?? process.platform
  let processHandle: BunSubprocess
  let windowsLaunch: WindowsBunPtyLaunch | null = null
  let windowsJob: WindowsBunPtyJob | null = null
  let clearInFlight: Promise<number> | null = null
  let decodePending = ''
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()
  const decoder = new TextDecoder()
  let exited = false
  let exitCode = 0
  // Keep a closed Bun native handle from escaping as a daemon RPC failure.
  let terminalUnavailable = false
  let appliedCols = args.cols
  let appliedRows = args.rows

  const emitData = (data: string): void => {
    for (const listener of dataListeners) {
      listener(data)
    }
  }

  const emitExit = (code: number): void => {
    if (exited) {
      return
    }
    exited = true
    exitCode = code
    const pending = decoder.decode()
    if (pending) {
      decodePending += pending
    }
    if (decodePending) {
      emitData(decodePending)
      decodePending = ''
    }
    try {
      windowsJob?.close()
    } catch (error) {
      console.warn('[daemon/pty] Windows PTY job cleanup failed:', error)
    }
    try {
      windowsLaunch?.dispose()
    } catch (error) {
      console.warn('[daemon/pty] Windows PTY launch cleanup failed:', error)
    }
    for (const listener of exitListeners) {
      listener({ exitCode: code })
    }
    dataListeners.clear()
    exitListeners.clear()
  }

  if (platform === 'win32') {
    if (!(deps.assignHostJob ?? assignCurrentProcessToBunPtyHostJob)()) {
      throw new Error('Windows Bun PTY host crash ownership is unavailable')
    }
    windowsLaunch = (deps.createWindowsLaunch ?? createWindowsBunPtyLaunch)(args)
  }
  try {
    processHandle = runtime.spawn(windowsLaunch?.command ?? [args.file, ...args.args], {
      cwd: args.cwd,
      env: windowsLaunch?.env ?? args.env,
      ...(windowsLaunch
        ? { windowsVerbatimArguments: windowsLaunch.windowsVerbatimArguments }
        : {}),
      terminal: {
        cols: args.cols,
        rows: args.rows,
        name: args.env.TERM ?? 'xterm-256color',
        data: (_terminal, data) => {
          const decoded = decoder.decode(data, { stream: true })
          if (decoded) {
            emitData(decoded)
          }
        }
      }
    })
  } catch (error) {
    windowsLaunch?.dispose()
    throw error
  }
  if (windowsLaunch) {
    try {
      windowsJob = (deps.createJob ?? createWindowsBunPtyJob)(processHandle.pid)
      if (!windowsJob) {
        throw new Error('Windows Bun PTY job ownership is unavailable')
      }
      windowsLaunch.release()
    } catch (error) {
      windowsJob?.terminate()
      try {
        processHandle.kill('SIGTERM')
      } catch {
        // The failed gate release still owns cleanup through the job when available.
      }
      if (!processHandle.terminal.closed) {
        processHandle.terminal.close()
      }
      windowsJob?.close()
      windowsLaunch.dispose()
      void processHandle.exited.catch(() => {})
      throw error
    }
  }
  void processHandle.exited.then(emitExit, () => emitExit(1))

  const producerFlowControl = createBunPtyProducerFlowControl({
    platform,
    processHandle,
    windowsJob,
    isExited: () => exited,
    ...(deps.readProcessTable ? { readProcessTable: deps.readProcessTable } : {}),
    ...(deps.signalProcessGroup ? { signalProcessGroup: deps.signalProcessGroup } : {})
  })

  const windowsJobCapabilities = windowsJob
    ? {
        terminateOwnedTree: () => windowsJob?.terminate() ?? 'unavailable',
        listOwnedProcessIds: () => windowsJob?.listProcessIds() ?? null
      }
    : {}
  const windowsWrapperCapabilities = windowsLaunch
    ? {
        jobRootProcessIsWrapper: true as const,
        signalProcess(signal: string) {
          if (signal === 'SIGWINCH') {
            return
          }
          if (windowsJob?.terminate() === 'terminated') {
            return
          }
          try {
            processHandle.kill(signal)
          } finally {
            if (!processHandle.terminal.closed) {
              processHandle.terminal.close()
            }
          }
        }
      }
    : {}

  const clearCapability =
    platform === 'win32' && windowsLaunch
      ? {
          clear() {
            if (exited || clearInFlight) {
              return
            }
            try {
              const clearProcess = runtime.spawn(windowsLaunch.clearCommand, {
                cwd: args.cwd,
                env: args.env,
                terminal: processHandle.terminal,
                windowsVerbatimArguments: true
              })
              clearInFlight = clearProcess.exited
              void clearInFlight.then(
                () => {
                  clearInFlight = null
                },
                () => {
                  clearInFlight = null
                }
              )
            } catch {
              clearInFlight = null
            }
          }
        }
      : {}

  return {
    pid: processHandle.pid,
    process: args.file,
    get cols() {
      return appliedCols
    },
    get rows() {
      return appliedRows
    },
    onData(listener) {
      if (exited) {
        return { dispose() {} }
      }
      dataListeners.add(listener)
      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit(listener) {
      if (exited) {
        listener({ exitCode })
        return { dispose() {} }
      }
      exitListeners.add(listener)
      return { dispose: () => exitListeners.delete(listener) }
    },
    write(data) {
      if (exited || terminalUnavailable || processHandle.terminal.closed) {
        return
      }
      try {
        processHandle.terminal.write(data)
      } catch {
        terminalUnavailable = true
      }
    },
    resize(cols, rows) {
      if (exited || terminalUnavailable || processHandle.terminal.closed) {
        return
      }
      try {
        processHandle.terminal.resize(cols, rows)
        appliedCols = cols
        appliedRows = rows
      } catch {
        terminalUnavailable = true
      }
    },
    ...clearCapability,
    ...producerFlowControl,
    ...windowsJobCapabilities,
    ...windowsWrapperCapabilities,
    kill() {
      producerFlowControl.resumeForShutdown()
      const treeTerminated = windowsJob?.terminate() === 'terminated'
      try {
        processHandle.kill('SIGTERM')
      } catch (error) {
        if (!treeTerminated) {
          throw error
        }
      }
    },
    destroy() {
      if (!processHandle.terminal.closed) {
        producerFlowControl.resumeForShutdown()
        const treeTerminated = windowsJob?.terminate() === 'terminated'
        try {
          processHandle.kill(platform === 'win32' ? 'SIGTERM' : 'SIGHUP')
        } catch (error) {
          if (!treeTerminated && !exited) {
            throw error
          }
        }
        processHandle.terminal.close()
      }
    }
  } as unknown as BunPtyProcess
}
