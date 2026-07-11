import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { posix } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Event as WatcherEvent } from '@parcel/watcher'

export type WslHostStopReason = 'failure' | 'topology'

export type WslHostSubscriptionContext = {
  distro: string
  linuxPath: string
  ignoreDirs: readonly string[]
  onEvents: (events: WatcherEvent[]) => void
  onOverflow: () => void
  onStopped: (reason: WslHostStopReason) => void
}

export type WslHostSubscriptionRecord = {
  id: number
  context: WslHostSubscriptionContext
  pending: { resolve: () => void; reject: (error: Error) => void } | null
  pendingTimer: ReturnType<typeof setTimeout> | null
}

export type WslDistroHost = {
  distro: string
  process: ChildProcessWithoutNullStreams | null
  starting: Promise<void> | null
  bootstrapAbortController: AbortController | null
  retired: boolean
  pendingAcquisitions: number
  subscriptions: Map<number, WslHostSubscriptionRecord>
  nextId: number
  streamBuffer: string
  stdoutDecoder: StringDecoder
  stderrDecoder: StringDecoder
  stderrTail: string
}

const hosts = new Map<string, WslDistroHost>()

function distroKey(distro: string): string {
  return distro.toLowerCase()
}

export function canonicalizeWslLinuxPath(linuxPath: string): string {
  const absolute = linuxPath.startsWith('/') ? linuxPath : `/${linuxPath}`
  const normalized = posix.normalize(absolute)
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '')
}

function createHost(distro: string): WslDistroHost {
  return {
    distro,
    process: null,
    starting: null,
    bootstrapAbortController: null,
    retired: false,
    pendingAcquisitions: 0,
    subscriptions: new Map(),
    nextId: 1,
    streamBuffer: '',
    stdoutDecoder: new StringDecoder('utf8'),
    stderrDecoder: new StringDecoder('utf8'),
    stderrTail: ''
  }
}

export function acquireWslDistroHost(distro: string): WslDistroHost {
  const key = distroKey(distro)
  let host = hosts.get(key)
  if (!host) {
    host = createHost(distro)
    hosts.set(key, host)
  }
  host.pendingAcquisitions += 1
  return host
}

export function releaseHostOwnership(host: WslDistroHost): void {
  // Why: a delayed close from a replaced child must not delete its successor.
  const key = distroKey(host.distro)
  if (hosts.get(key) === host) {
    hosts.delete(key)
  }
}

export function stopHostIfUnused(host: WslDistroHost): boolean {
  if (host.pendingAcquisitions > 0 || host.subscriptions.size > 0) {
    return false
  }
  releaseHostOwnership(host)
  host.retired = true
  host.bootstrapAbortController?.abort()
  const child = host.process
  host.process = null
  child?.kill()
  return true
}

export function releaseWslDistroHost(host: WslDistroHost): void {
  host.pendingAcquisitions -= 1
  stopHostIfUnused(host)
}

export function handleWslHostGone(
  host: WslDistroHost,
  child: ChildProcessWithoutNullStreams
): void {
  if (host.process !== child) {
    return
  }
  host.process = null
  releaseHostOwnership(host)
  const error = new Error(
    `Managed WSL watcher exited${host.stderrTail.trim() ? `: ${host.stderrTail.trim()}` : ''}`
  )
  for (const record of host.subscriptions.values()) {
    if (record.pendingTimer) {
      clearTimeout(record.pendingTimer)
      record.pendingTimer = null
    }
    if (record.pending) {
      record.pending.reject(error)
      record.pending = null
    } else {
      record.context.onStopped('failure')
    }
  }
  host.subscriptions.clear()
}

export function resetWslDistroHostsForTest(): void {
  for (const host of hosts.values()) {
    host.retired = true
    host.bootstrapAbortController?.abort()
    host.process?.kill()
  }
  hosts.clear()
}
