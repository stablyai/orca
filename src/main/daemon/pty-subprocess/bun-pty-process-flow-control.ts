import type { WindowsBunPtyJob } from './windows-bun-pty-job'
import { signalPosixPtyProcessGroups } from '../../pty/posix-pty-process-groups'

type BunPtyProcessHandle = Readonly<{
  pid: number
  kill(signal?: string | number): void
  terminal: Readonly<{ closed: boolean; close(): void }>
}>

export type BunPtyProducerFlowControl = Readonly<{
  pause(): void
  resume(): void
  resumeForShutdown(): void
}>

export function createBunPtyProducerFlowControl(
  options: Readonly<{
    platform: NodeJS.Platform
    processHandle: BunPtyProcessHandle
    windowsJob: WindowsBunPtyJob | null
    isExited: () => boolean
    readProcessTable?: () => string
    signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void
  }>
): BunPtyProducerFlowControl {
  let paused = false

  const signalProcessGroup = (signal: 'SIGSTOP' | 'SIGCONT'): void => {
    signalPosixPtyProcessGroups(
      options.processHandle.pid,
      signal,
      () => {
        options.processHandle.kill(signal)
      },
      {
        platform: options.platform,
        ...(options.readProcessTable ? { readProcessTable: options.readProcessTable } : {}),
        ...(options.signalProcessGroup
          ? { signalProcessGroup: (pgid: number) => options.signalProcessGroup?.(pgid, signal) }
          : {})
      }
    )
  }

  const resume = (): void => {
    if (options.isExited() || !paused) {
      return
    }
    signalProcessGroup('SIGCONT')
    paused = false
  }

  return {
    pause() {
      if (options.isExited() || paused) {
        return
      }
      if (options.platform === 'win32') {
        if (options.windowsJob?.pause()) {
          paused = true
        } else {
          options.windowsJob?.terminate()
          if (!options.processHandle.terminal.closed) {
            options.processHandle.terminal.close()
          }
        }
        return
      }
      signalProcessGroup('SIGSTOP')
      paused = true
    },
    resume() {
      if (options.platform === 'win32') {
        if (!options.isExited() && options.windowsJob?.resume()) {
          paused = false
        }
        return
      }
      resume()
    },
    resumeForShutdown() {
      if (options.platform === 'win32') {
        options.windowsJob?.resume()
        paused = false
        return
      }
      try {
        resume()
      } catch {
        paused = false
      }
    }
  }
}
