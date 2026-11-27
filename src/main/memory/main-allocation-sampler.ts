import { ipcMain } from 'electron'
import type { HeapProfiler } from 'node:inspector'
import { Session } from 'node:inspector/promises'
import { isRecord } from '../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import type { CrashReportDetailValue } from '../../shared/crash-reporting/crash-reporting'

/**
 * Names what main allocates during a memory spike: V8's sampling heap profiler plus a per-channel
 * IPC tally, both only for a bounded window after a spike fires, so main does no work otherwise.
 * Records hold function names, script basenames and channel names; never arguments or paths.
 */
export const MAIN_ALLOCATION_WINDOW_MS = 15_000
/** Mean bytes between samples; coarse enough that ~250 MB of churn yields ~500 samples. */
const SAMPLING_INTERVAL_BYTES = 512 * 1024
const TOP_STACKS = 20
const STACK_FRAMES = 8
const STACK_MAX_CHARS = 400
const TOP_CHANNELS = 20
/** Bounds the per-message size walk so a huge payload costs at most this many visits. */
const SIZE_WALK_BUDGET = 2_000
const MB = 2 ** 20

type Details = Record<string, CrashReportDetailValue>
type ProfileNode = HeapProfiler.SamplingHeapProfileNode
type ChannelTally = { calls: number; bytes: number }
type InvokeHandler = (...args: unknown[]) => unknown

let active = false

export async function sampleMainAllocations(
  windowMs: number = MAIN_ALLOCATION_WINDOW_MS
): Promise<Details> {
  if (active) {
    return { allocationSamplingSkipped: true }
  }
  active = true
  const session = new Session()
  const heapBeforeMB = process.memoryUsage().heapUsed / MB
  let stopIpcTally: (() => Map<string, ChannelTally>) | null = null
  try {
    session.connect()
    await session.post('HeapProfiler.enable')
    const sampling = {
      samplingInterval: SAMPLING_INTERVAL_BYTES,
      // Bursts that are freed again (stringify, journal reads) matter as much as retained ones.
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true
    }
    await session.post('HeapProfiler.startSampling', sampling)
    stopIpcTally = startIpcTally()
    await new Promise((resolve) => setTimeout(resolve, windowMs).unref())
    const channels = stopIpcTally()
    stopIpcTally = null
    const { profile } = await session.post('HeapProfiler.stopSampling')
    return {
      allocationWindowMs: windowMs,
      allocationWindowHeapGrowthMB: Math.round(process.memoryUsage().heapUsed / MB - heapBeforeMB),
      ...summarizeAllocationProfile(profile.head),
      ...summarizeIpcTally(channels)
    }
  } catch {
    return { allocationSamplingError: true }
  } finally {
    stopIpcTally?.()
    try {
      session.disconnect()
    } catch {
      // Already disconnected.
    }
    active = false
  }
}

export function summarizeAllocationProfile(head: ProfileNode): Details {
  const parents = new Map<ProfileNode, ProfileNode>()
  const nodes: ProfileNode[] = []
  const pending = [head]
  let totalBytes = 0
  while (pending.length > 0) {
    const node = pending.pop()!
    nodes.push(node)
    totalBytes += node.selfSize
    for (const child of node.children) {
      parents.set(child, node)
      pending.push(child)
    }
  }
  const details: Details = { allocationSampledMB: Math.round(totalBytes / MB) }
  nodes
    .filter((node) => node.selfSize > 0)
    .sort((a, b) => b.selfSize - a.selfSize)
    .slice(0, TOP_STACKS)
    .forEach((node, index) => {
      const frames: string[] = []
      for (
        let at: ProfileNode | undefined = node;
        at && at !== head && frames.length < STACK_FRAMES;
        at = parents.get(at)
      ) {
        frames.push(formatFrame(at.callFrame))
      }
      details[`alloc_${index + 1}_kb`] = Math.round(node.selfSize / 1024)
      details[`alloc_${index + 1}_stack`] = frames.join(' < ').slice(0, STACK_MAX_CHARS)
    })
  return details
}

/** Basename only: install paths can hold the user's home directory. */
function formatFrame(frame: ProfileNode['callFrame']): string {
  const file = frame.url.split(/[?#]/)[0].split(/[/\\]/).pop() ?? ''
  const safeFile = /^[\w.-]{1,60}$/.test(file) ? file : file ? '?' : ''
  const name = (frame.functionName || '(anonymous)').slice(0, 60)
  return safeFile ? `${name} ${safeFile}:${frame.lineNumber + 1}` : name
}

/** Wraps handlers only for the window; Electron reads its invoke map directly, so values are swapped. */
function startIpcTally(): () => Map<string, ChannelTally> {
  const tally = new Map<string, ChannelTally>()
  const count = (channel: unknown, payload: unknown, calls = 1): void => {
    const key = safeChannel(channel)
    const entry = tally.get(key) ?? { calls: 0, bytes: 0 }
    entry.calls += calls
    entry.bytes += approxBytes(payload)
    tally.set(key, entry)
  }
  const handlers: Map<unknown, unknown> | null =
    '_invokeHandlers' in ipcMain && ipcMain._invokeHandlers instanceof Map
      ? ipcMain._invokeHandlers
      : null
  const wrapped = new Map<unknown, { original: InvokeHandler; wrapper: InvokeHandler }>()
  for (const [channel, original] of handlers ?? []) {
    if (!isInvokeHandler(original)) {
      continue
    }
    const wrapper: InvokeHandler = (event, ...args) => {
      count(channel, args)
      const result = original(event, ...args)
      if (result instanceof Promise) {
        void result.then(
          (value) => count(channel, value, 0),
          () => {}
        )
      } else {
        count(channel, result, 0)
      }
      return result
    }
    handlers!.set(channel, wrapper)
    wrapped.set(channel, { original, wrapper })
  }
  const originalEmit = ipcMain.emit
  const emitWrapper = function (this: unknown, channel: string | symbol, ...args: unknown[]) {
    if (typeof channel === 'string') {
      count(channel, args.slice(1))
    }
    return originalEmit.call(this, channel, ...args)
  }
  ipcMain.emit = emitWrapper
  let stopped = false
  return () => {
    if (!stopped) {
      stopped = true
      // Leave a handler re-registered during the window alone.
      for (const [channel, { original, wrapper }] of wrapped) {
        if (handlers!.get(channel) === wrapper) {
          handlers!.set(channel, original)
        }
      }
      if (ipcMain.emit === emitWrapper) {
        ipcMain.emit = originalEmit
      }
    }
    return tally
  }
}

/** Bytes cover both a call's arguments and an invoke's result. */
function summarizeIpcTally(tally: Map<string, ChannelTally>): Details {
  const details: Details = { ipcChannels: tally.size }
  ;[...tally]
    .sort((a, b) => b[1].bytes - a[1].bytes || b[1].calls - a[1].calls)
    .slice(0, TOP_CHANNELS)
    .forEach(([channel, entry], index) => {
      details[`ipc_${index + 1}_channel`] = channel
      details[`ipc_${index + 1}_calls`] = entry.calls
      details[`ipc_${index + 1}_kb`] = Math.round(entry.bytes / 1024)
    })
  return details
}

function isInvokeHandler(value: unknown): value is InvokeHandler {
  return typeof value === 'function'
}

function safeChannel(channel: unknown): string {
  return typeof channel === 'string' && /^[\w:.-]{1,80}$/.test(channel) ? channel : '(other)'
}

/** Rough payload size; stops after a fixed number of visits so a huge payload stays cheap. */
export function approxBytes(value: unknown): number {
  let budget = SIZE_WALK_BUDGET
  let bytes = 0
  const pending: unknown[] = [value]
  while (pending.length > 0 && budget-- > 0) {
    const item = pending.pop()
    if (typeof item === 'string') {
      bytes += item.length
    } else if (typeof item === 'number' || typeof item === 'boolean') {
      bytes += 8
    } else if (ArrayBuffer.isView(item)) {
      bytes += item.byteLength
    } else if (item instanceof ArrayBuffer) {
      bytes += item.byteLength
    } else if (Array.isArray(item)) {
      pending.push(...item.slice(0, budget))
    } else if (isRecord(item)) {
      for (const key in item) {
        bytes += key.length
        pending.push(item[key])
        if (pending.length > budget) {
          break
        }
      }
    }
  }
  return bytes
}
