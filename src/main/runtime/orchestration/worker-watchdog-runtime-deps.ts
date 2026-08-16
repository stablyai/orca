import type { spawn } from 'node:child_process'
import type { DescendantSnapshot } from '../../pty-descendant-termination'
import type { WindowsTreeKillTarget } from '../../windows-pty-root-identity'
import type {
  WorkerWatchdogSentinel,
  WorkerWatchdogStartedReceipt
} from './worker-watchdog-protocol'

export type WatchdogTimer = NodeJS.Timeout

export type WorkerWatchdogRuntimeDeps = {
  platform?: NodeJS.Platform
  spawnImpl?: typeof spawn
  now?: () => number
  setTimeoutImpl?: (callback: () => void, delay: number) => WatchdogTimer
  clearTimeoutImpl?: (timer: WatchdogTimer) => void
  killImpl?: (pid: number, signal: NodeJS.Signals) => void
  terminateWindowsTreeImpl?: (pid: number) => Promise<void>
  captureDescendantsImpl?: (pid: number) => Promise<DescendantSnapshot | null>
  terminateDescendantsImpl?: (snapshot: DescendantSnapshot) => void
  forceTerminateDescendantsImpl?: (snapshot: DescendantSnapshot) => Promise<number>
  signalLiveDescendantsImpl?: (
    snapshot: DescendantSnapshot,
    signal: NodeJS.Signals
  ) => Promise<number>
  verifyWindowsTreeKillTargetImpl?: (pid: number) => Promise<WindowsTreeKillTarget>
  writeSentinelImpl?: (path: string, sentinel: WorkerWatchdogSentinel) => void
  onStarted?: (receipt: WorkerWatchdogStartedReceipt) => void
  signalSource?: {
    once(event: 'SIGHUP' | 'SIGTERM' | 'SIGINT', listener: () => void): unknown
    removeListener(event: 'SIGHUP' | 'SIGTERM' | 'SIGINT', listener: () => void): unknown
  }
}
