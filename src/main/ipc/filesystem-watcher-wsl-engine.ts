import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { Event as WatcherEvent } from '@parcel/watcher'
import {
  subscribeViaWslWatcherHost,
  type WslHostStopReason,
  type WslHostSubscription
} from './filesystem-watcher-wsl-host-client'
import {
  buildSnapshotScript,
  diffSnapshots,
  MAX_SNAPSHOT_RECORD_CHARS,
  parseSnapshotRecord,
  type WslSnapshot
} from './filesystem-watcher-wsl-snapshot'

export type WslWatchEngine = {
  ready: Promise<void>
  stopped: Promise<WslHostStopReason>
  stop(): void
}

export type WslEngineContext = {
  distro: string
  linuxPath: string
  worktreePath: string
  ignoreDirs: readonly string[]
  onEvents: (events: WatcherEvent[]) => void
  onOverflow: () => void
}

const SNAPSHOT_STARTUP_TIMEOUT_MS = 30_000
const MAX_SNAPSHOT_ENTRIES = 1_000_000

function createChildEngine(
  args: string[],
  stdin: string,
  startupTimeoutMs: number,
  worktreePath: string,
  handleStdout: (chunk: Buffer, settleReady: (error?: Error) => void, stop: () => void) => void
): WslWatchEngine {
  const child = spawn('wsl.exe', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  let disposed = false
  let readySettled = false
  let stoppedSettled = false
  let stderrTail = ''
  const stderrDecoder = new StringDecoder('utf8')
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  let resolveStopped!: (reason: WslHostStopReason) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const stopped = new Promise<WslHostStopReason>((resolve) => {
    resolveStopped = resolve
  })
  const settleReady = (error?: Error): void => {
    if (readySettled) {
      return
    }
    readySettled = true
    clearTimeout(startupTimer)
    if (error) {
      rejectReady(error)
    } else {
      resolveReady()
    }
  }
  const settleStopped = (): void => {
    if (stoppedSettled) {
      return
    }
    stoppedSettled = true
    resolveStopped('failure')
  }
  const stop = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    child.kill()
  }
  const startupTimer = setTimeout(() => {
    settleReady(new Error(`Timed out starting WSL watcher for ${worktreePath}`))
    stop()
  }, startupTimeoutMs)

  child.stdin.on('error', (error) => {
    if (!readySettled) {
      settleReady(error)
    }
  })
  child.stdout.on('data', (chunk: Buffer) => {
    if (!disposed) {
      handleStdout(chunk, settleReady, stop)
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + stderrDecoder.write(chunk)).slice(-4096)
  })
  child.stdout.on('error', (error) => {
    if (!readySettled) {
      settleReady(error)
    } else if (!disposed) {
      stop()
    }
  })
  child.stderr.on('error', () => undefined)
  child.once('error', (error) => {
    if (!readySettled) {
      settleReady(error)
    } else if (!disposed) {
      stop()
    }
    settleStopped()
  })
  child.once('close', (code, signal) => {
    if (!readySettled) {
      const suffix = stderrTail.trim() ? `: ${stderrTail.trim()}` : ''
      settleReady(new Error(`WSL watcher exited before ready (${code ?? signal})${suffix}`))
    }
    settleStopped()
  })
  child.stdin.end(stdin)
  return { ready, stopped, stop }
}

export function createWslNativeEngine(context: WslEngineContext): WslWatchEngine {
  let subscription: WslHostSubscription | null = null
  const abortController = new AbortController()
  let disposed = false
  let stoppedSettled = false
  let resolveStopped!: (reason: WslHostStopReason) => void
  const stopped = new Promise<WslHostStopReason>((resolve) => {
    resolveStopped = resolve
  })
  const settleStopped = (reason: WslHostStopReason = 'failure'): void => {
    if (!stoppedSettled) {
      stoppedSettled = true
      resolveStopped(reason)
    }
  }
  const ready = subscribeViaWslWatcherHost(
    {
      distro: context.distro,
      linuxPath: context.linuxPath,
      ignoreDirs: context.ignoreDirs,
      onEvents: context.onEvents,
      onOverflow: context.onOverflow,
      onStopped: settleStopped
    },
    abortController.signal
  ).then((created) => {
    if (disposed) {
      created.unsubscribe()
    } else {
      subscription = created
    }
  })
  return {
    ready,
    stopped,
    stop: () => {
      if (disposed) {
        return
      }
      disposed = true
      abortController.abort()
      subscription?.unsubscribe()
      subscription = null
      settleStopped()
    }
  }
}

export function createWslSnapshotEngine(context: WslEngineContext): WslWatchEngine {
  let recordBuffer = ''
  let current: WslSnapshot = new Map()
  let previous: WslSnapshot | null = null
  const decoder = new StringDecoder('utf8')
  const finishSnapshot = (settleReady: (error?: Error) => void): void => {
    if (!previous) {
      previous = current
      settleReady()
    } else {
      const events = diffSnapshots(previous, current)
      previous = current
      if (events.length > 0) {
        context.onEvents(events)
      }
    }
    current = new Map()
  }
  return createChildEngine(
    ['-d', context.distro, '--', 'sh', '-s', '--', context.linuxPath],
    buildSnapshotScript(context.ignoreDirs),
    SNAPSHOT_STARTUP_TIMEOUT_MS,
    context.worktreePath,
    (chunk, settleReady, stop) => {
      recordBuffer += decoder.write(chunk)
      while (true) {
        const end = recordBuffer.indexOf('\0')
        if (end === -1) {
          if (recordBuffer.length > MAX_SNAPSHOT_RECORD_CHARS) {
            context.onOverflow()
            stop()
          }
          return
        }
        const rawRecord = recordBuffer.slice(0, end)
        recordBuffer = recordBuffer.slice(end + 1)
        if (rawRecord.length === 0) {
          finishSnapshot(settleReady)
        } else {
          const parsed = parseSnapshotRecord(rawRecord, context.distro)
          if (!parsed || current.size >= MAX_SNAPSHOT_ENTRIES) {
            context.onOverflow()
            stop()
            return
          }
          current.set(...parsed)
        }
      }
    }
  )
}
