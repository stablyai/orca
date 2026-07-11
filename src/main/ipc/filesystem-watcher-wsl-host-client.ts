import { spawn } from 'node:child_process'
import {
  acquireWslDistroHost,
  canonicalizeWslLinuxPath,
  handleWslHostGone,
  releaseHostOwnership,
  releaseWslDistroHost,
  resetWslDistroHostsForTest,
  stopHostIfUnused,
  type WslDistroHost,
  type WslHostStopReason,
  type WslHostSubscriptionContext,
  type WslHostSubscriptionRecord
} from './filesystem-watcher-wsl-host-lifecycle'
import { wslHostMessageEvents, type WslHostMessage } from './filesystem-watcher-wsl-host-protocol'
import { ensureWslWatcherRuntime } from './filesystem-watcher-wsl-runtime'

export type {
  WslHostStopReason,
  WslHostSubscriptionContext
} from './filesystem-watcher-wsl-host-lifecycle'

export type WslHostSubscription = {
  unsubscribe(): void
}

export class WslWatcherTopologyError extends Error {}

const STARTUP_TIMEOUT_MS = 30_000
const SUBSCRIBE_TIMEOUT_MS = 30_000
const MAX_STREAM_BUFFER_CHARS = 10 * 1024 * 1024

function settleRecordFailure(
  host: WslDistroHost,
  record: WslHostSubscriptionRecord,
  error: Error,
  reason: WslHostStopReason = 'failure'
): void {
  host.subscriptions.delete(record.id)
  if (record.pendingTimer) {
    clearTimeout(record.pendingTimer)
    record.pendingTimer = null
  }
  if (reason === 'topology') {
    record.context.onOverflow()
  }
  if (record.pending) {
    record.pending.reject(error)
    record.pending = null
  } else {
    record.context.onStopped(reason)
  }
  if (!stopHostIfUnused(host)) {
    send(host, { op: 'unsubscribe', id: record.id })
  }
}

function handleMessage(
  host: WslDistroHost,
  message: WslHostMessage,
  settleReady: () => void
): void {
  if (message.op === 'ready') {
    if (message.protocol === 1) {
      settleReady()
    } else {
      host.process?.kill()
    }
    return
  }
  if (message.op === 'protocol-error') {
    host.process?.kill()
    return
  }
  if (!Number.isSafeInteger(message.id)) {
    return
  }
  const record = host.subscriptions.get(message.id as number)
  if (!record) {
    return
  }
  if (message.op === 'subscribed') {
    if (record.pendingTimer) {
      clearTimeout(record.pendingTimer)
      record.pendingTimer = null
    }
    record.pending?.resolve()
    record.pending = null
  } else if (message.op === 'subscribe-failed') {
    settleRecordFailure(host, record, new Error(String(message.message ?? 'subscribe failed')))
  } else if (message.op === 'watch-error') {
    const topology = message.reason === 'topology'
    const ErrorType = topology ? WslWatcherTopologyError : Error
    const error = new ErrorType(String(message.message ?? 'watch failed'))
    settleRecordFailure(host, record, error, topology ? 'topology' : 'failure')
  } else if (message.op === 'events') {
    const events = wslHostMessageEvents(message, record.context)
    if (events.length > 0) {
      record.context.onEvents(events)
    }
  }
}

function send(host: WslDistroHost, message: object): boolean {
  try {
    if (!host.process?.stdin.writable) {
      return false
    }
    host.process.stdin.write(`${JSON.stringify(message)}\n`)
    return true
  } catch {
    return false
  }
}

async function startHost(host: WslDistroHost, signal: AbortSignal): Promise<void> {
  const runtime = await ensureWslWatcherRuntime(host.distro, signal)
  if (host.retired) {
    throw new Error('Managed WSL watcher startup was cancelled')
  }
  const child = spawn(
    'wsl.exe',
    ['-d', host.distro, '--exec', runtime.nodePath, runtime.hostPath],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  )
  host.process = child
  host.streamBuffer = ''
  host.stderrTail = ''
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const timer = setTimeout(() => {
      settle(new Error(`Timed out starting managed WSL watcher for ${host.distro}`))
      child.kill()
    }, STARTUP_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      host.streamBuffer += host.stdoutDecoder.write(chunk)
      if (host.streamBuffer.length > MAX_STREAM_BUFFER_CHARS) {
        settle(new Error('Managed WSL watcher protocol buffer overflow'))
        child.kill()
        return
      }
      let newline = host.streamBuffer.indexOf('\n')
      while (newline !== -1) {
        const line = host.streamBuffer.slice(0, newline)
        host.streamBuffer = host.streamBuffer.slice(newline + 1)
        try {
          handleMessage(host, JSON.parse(line) as WslHostMessage, () => settle())
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)))
          child.kill()
          return
        }
        newline = host.streamBuffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      host.stderrTail = (host.stderrTail + host.stderrDecoder.write(chunk)).slice(-4096)
    })
    child.stdin.on('error', (error) => {
      settle(error)
      child.kill()
      handleWslHostGone(host, child)
    })
    child.stdout.on('error', (error) => {
      settle(error)
      child.kill()
      handleWslHostGone(host, child)
    })
    // Diagnostics are optional; an unreadable stderr pipe must not crash main.
    child.stderr.on('error', () => undefined)
    child.once('error', (error) => {
      settle(error)
      handleWslHostGone(host, child)
    })
    child.once('close', (code, signal) => {
      settle(new Error(`Managed WSL watcher exited before ready (${code ?? signal})`))
      handleWslHostGone(host, child)
    })
  })
}

function ensureHost(host: WslDistroHost): Promise<WslDistroHost> {
  if (!host.starting && !host.process) {
    const bootstrapAbortController = new AbortController()
    host.bootstrapAbortController = bootstrapAbortController
    const starting = startHost(host, bootstrapAbortController.signal)
      .catch((error) => {
        const child = host.process
        host.process = null
        releaseHostOwnership(host)
        child?.kill()
        throw error
      })
      .finally(() => {
        if (host.starting === starting) {
          host.starting = null
        }
        if (host.bootstrapAbortController === bootstrapAbortController) {
          host.bootstrapAbortController = null
        }
      })
    host.starting = starting
  }
  return host.starting ? host.starting.then(() => host) : Promise.resolve(host)
}

async function ensureHostAvailable(
  host: WslDistroHost,
  signal: AbortSignal | undefined
): Promise<WslDistroHost> {
  if (!signal) {
    return ensureHost(host)
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = (): void => rejectAbort(new Error('Managed WSL watcher subscription cancelled'))
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([ensureHost(host), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export async function subscribeViaWslWatcherHost(
  context: WslHostSubscriptionContext,
  signal?: AbortSignal
): Promise<WslHostSubscription> {
  if (signal?.aborted) {
    throw new Error('Managed WSL watcher subscription cancelled')
  }
  const normalizedContext = {
    ...context,
    linuxPath: canonicalizeWslLinuxPath(context.linuxPath)
  }
  let host: WslDistroHost | null = null
  try {
    // Why: reservations prevent one cancelled caller from killing a host that
    // another same-distro caller is still waiting to use.
    host = acquireWslDistroHost(normalizedContext.distro)
    await ensureHostAvailable(host, signal)
    if (signal?.aborted) {
      throw new Error('Managed WSL watcher subscription cancelled')
    }
    const id = host.nextId++
    const record: WslHostSubscriptionRecord = {
      id,
      context: normalizedContext,
      pending: null,
      pendingTimer: null
    }
    const ready = new Promise<void>((resolve, reject) => {
      record.pending = { resolve, reject }
    })
    host.subscriptions.set(id, record)
    record.pendingTimer = setTimeout(() => {
      settleRecordFailure(host!, record, new Error('Timed out subscribing managed WSL watcher'))
    }, SUBSCRIBE_TIMEOUT_MS)
    signal?.addEventListener(
      'abort',
      () => {
        if (host?.subscriptions.has(id)) {
          settleRecordFailure(host, record, new Error('Managed WSL watcher subscription cancelled'))
        }
      },
      { once: true }
    )
    if (
      !send(host, {
        op: 'subscribe',
        id,
        dir: normalizedContext.linuxPath,
        ignoreDirs: normalizedContext.ignoreDirs
      })
    ) {
      settleRecordFailure(host, record, new Error('Managed WSL watcher is unavailable'))
    }
    await ready
    return {
      unsubscribe: () => {
        if (!host?.subscriptions.delete(id)) {
          return
        }
        if (!stopHostIfUnused(host)) {
          send(host, { op: 'unsubscribe', id })
        }
      }
    }
  } finally {
    if (host) {
      releaseWslDistroHost(host)
    }
  }
}

export function resetWslWatcherHostsForTest(): void {
  resetWslDistroHostsForTest()
}
