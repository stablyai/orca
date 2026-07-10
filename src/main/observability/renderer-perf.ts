import { app, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { acquireElectronDebugger } from '../browser/electron-debugger-lease'
import {
  narrowRendererPerfMetrics,
  type RendererPerfDomCounters,
  type RendererPerfMetrics,
  type RendererPerfProcessMemory,
  type RendererPerfRecord,
  type RendererPerfUnavailableReason
} from '../../shared/renderer-perf-metrics'

type PendingRendererPerfRequest = {
  readonly trustedWebContentsId: number
  readonly timeout: NodeJS.Timeout
  readonly resolve: (result: RendererPerfResponseResult) => void
}

type CollectRendererPerfMetricsOptions = {
  readonly timeoutMs?: number
  /** 'anonymous' (default) replaces worktree labels with stable `worktree-N`
   *  placeholders for records that ride the uploadable diagnostics bundle;
   *  'named' keeps folder basenames and is reserved for the local-only
   *  consent-gated perf dump. */
  readonly labelMode?: 'anonymous' | 'named'
}

const DEFAULT_TIMEOUT_MS = 1500
const pendingRequests = new Map<string, PendingRendererPerfRequest>()
let responseListenerInstalled = false

type RendererPerfResponseResult =
  | { readonly status: 'ok'; readonly metrics: RendererPerfMetrics }
  | { readonly status: 'invalid-response' }
  | { readonly status: 'send-failed' }
  | { readonly status: 'timeout' }

export async function collectRendererPerfMetrics(
  getRendererWebContents: () => WebContents | null,
  opts: CollectRendererPerfMetricsOptions = {}
): Promise<RendererPerfRecord> {
  const collectedAt = new Date().toISOString()
  const webContents = getRendererWebContents()
  const unavailable: Record<string, string> = {}

  if (!webContents) {
    return unavailableRecord(collectedAt, 'no-renderer')
  }
  if (webContents.isDestroyed()) {
    return unavailableRecord(collectedAt, 'renderer-destroyed')
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const [renderer, main] = await Promise.all([
    requestRendererMetrics(webContents, timeoutMs),
    collectMainMetrics(webContents, timeoutMs)
  ])
  const rendererMetrics = renderer.metrics
    ? withLabelMode(renderer.metrics, opts.labelMode ?? 'anonymous')
    : null

  if (renderer.reason) {
    unavailable.renderer = renderer.reason
  }
  if (main.domCountersReason) {
    unavailable.domCounters = main.domCountersReason
  }
  if (main.processMemoryReason) {
    unavailable.processMemory = main.processMemoryReason
  }

  return {
    type: 'renderer-perf',
    schema_version: 1,
    collected_at: collectedAt,
    ...(rendererMetrics ? { renderer: rendererMetrics } : {}),
    ...(main.metrics ? { main: main.metrics } : {}),
    ...(renderer.reason && !rendererMetrics && !main.metrics
      ? { unavailableReason: renderer.reason }
      : {}),
    ...(Object.keys(unavailable).length > 0 ? { unavailable } : {})
  }
}

/** Anonymous mode keeps per-worktree/per-pane counts (the ticket's cheap
 *  metrics) but strips user-chosen folder names from uploadable records. */
function withLabelMode(
  metrics: RendererPerfMetrics,
  labelMode: 'anonymous' | 'named'
): RendererPerfMetrics {
  if (labelMode === 'named') {
    return metrics
  }
  return {
    ...metrics,
    terminalPanes: {
      ...metrics.terminalPanes,
      worktrees: metrics.terminalPanes.worktrees.map((worktree, index) => ({
        ...worktree,
        worktreeLabel: `worktree-${index + 1}`
      }))
    }
  }
}

function unavailableRecord(
  collectedAt: string,
  reason: RendererPerfUnavailableReason
): RendererPerfRecord {
  return {
    type: 'renderer-perf',
    schema_version: 1,
    collected_at: collectedAt,
    unavailableReason: reason,
    unavailable: { renderer: reason }
  }
}

function ensureResponseListener(): void {
  if (responseListenerInstalled) {
    return
  }
  responseListenerInstalled = true
  ipcMain.on('diagnostics:rendererPerf:response', (event, args?: unknown) => {
    if (!args || typeof args !== 'object') {
      return
    }
    const payload = args as { requestId?: unknown; metrics?: unknown }
    if (typeof payload.requestId !== 'string') {
      return
    }
    const pending = pendingRequests.get(payload.requestId)
    if (!pending || event.sender.id !== pending.trustedWebContentsId) {
      return
    }
    const metrics = narrowRendererPerfMetrics(payload.metrics)
    settleRendererPerfRequest(
      payload.requestId,
      metrics ? { status: 'ok', metrics } : { status: 'invalid-response' }
    )
  })
}

function settleRendererPerfRequest(requestId: string, result: RendererPerfResponseResult): void {
  const pending = pendingRequests.get(requestId)
  if (!pending) {
    return
  }
  clearTimeout(pending.timeout)
  pendingRequests.delete(requestId)
  pending.resolve(result)
}

async function requestRendererMetrics(
  webContents: WebContents,
  timeoutMs: number
): Promise<{ metrics: RendererPerfMetrics | null; reason?: RendererPerfUnavailableReason }> {
  ensureResponseListener()
  const requestId = randomUUID()
  const result = await new Promise<RendererPerfResponseResult>((resolve) => {
    const timeout = setTimeout(
      () => {
        settleRendererPerfRequest(requestId, { status: 'timeout' })
      },
      Math.max(1, timeoutMs)
    )
    pendingRequests.set(requestId, {
      trustedWebContentsId: webContents.id,
      timeout,
      resolve
    })
    try {
      webContents.send('diagnostics:rendererPerf:request', { requestId })
    } catch {
      settleRendererPerfRequest(requestId, { status: 'send-failed' })
    }
  })

  if (result.status === 'ok') {
    return { metrics: result.metrics }
  }
  return {
    metrics: null,
    reason: webContents.isDestroyed() ? 'renderer-destroyed' : result.status
  }
}

async function collectMainMetrics(
  webContents: WebContents,
  timeoutMs: number
): Promise<{
  metrics?: NonNullable<RendererPerfRecord['main']>
  domCountersReason?: string
  processMemoryReason?: string
}> {
  const [domCounters, processMemory] = await Promise.all([
    collectDomCounters(webContents, timeoutMs),
    collectProcessMemory(webContents)
  ])
  const metrics: NonNullable<RendererPerfRecord['main']> = {
    ...(domCounters.value ? { domCounters: domCounters.value } : {}),
    ...(processMemory.value ? { processMemoryBytes: processMemory.value } : {})
  }
  return {
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    ...(domCounters.reason ? { domCountersReason: domCounters.reason } : {}),
    ...(processMemory.reason ? { processMemoryReason: processMemory.reason } : {})
  }
}

async function collectDomCounters(
  webContents: WebContents,
  timeoutMs: number
): Promise<{ value?: RendererPerfDomCounters; reason?: string }> {
  let lease: { release: () => void } | null = null
  try {
    lease = acquireElectronDebugger(webContents)
    // Why: a hung renderer can leave the CDP command pending forever; bound
    // it so bundle collection degrades instead of hanging with it.
    const result = (await withTimeout(
      webContents.debugger.sendCommand('Memory.getDOMCounters'),
      timeoutMs
    )) as Partial<RendererPerfDomCounters>
    return {
      value: {
        documents: clampCount(result.documents),
        nodes: clampCount(result.nodes),
        jsEventListeners: clampCount(result.jsEventListeners)
      }
    }
  } catch (error) {
    return { reason: formatReason(error) }
  } finally {
    lease?.release()
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timeout')), Math.max(1, timeoutMs))
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

async function collectProcessMemory(
  webContents: WebContents
): Promise<{ value?: RendererPerfProcessMemory; reason?: string }> {
  try {
    // Why: webContents.getProcessMemoryInfo() was removed from Electron;
    // app.getAppMetrics() is the supported source for per-process memory.
    const osPid = webContents.getOSProcessId()
    const memory = app.getAppMetrics().find((metric) => metric.pid === osPid)?.memory
    if (!memory) {
      return { reason: 'renderer process metric unavailable' }
    }
    const normalized: RendererPerfProcessMemory = {}
    for (const [key, value] of Object.entries(memory)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        // Electron reports MemoryInfo fields in KiB.
        normalized[`${key}Bytes`] = clampCount(value * 1024)
      }
    }
    return Object.keys(normalized).length > 0 ? { value: normalized } : {}
  } catch (error) {
    return { reason: formatReason(error) }
  }
}

function clampCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.floor(value))
}

function formatReason(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 160) : 'unavailable'
}
