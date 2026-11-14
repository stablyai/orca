// Arm-neutral 4a probes: renderer-clock end points, host CPU/event-loop work, memory and on-disk storage, read from outside product code.
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { summarizeEventLoopDelay } from '../../../../tests/e2e/helpers/event-loop-delay-report'

export { installVisibilityProbe, watchMarkers } from './native-chat-4a-visibility'

/** The refusal some writes (create, fork) carry inside a successful call: `{ ok: false, refusal }`. */
function inResultRefusal(result: unknown): { refusal: unknown } | null {
  return typeof result === 'object' &&
    result !== null &&
    'ok' in result &&
    result.ok === false &&
    'refusal' in result
    ? { refusal: result.refusal }
    : null
}

/** A waitForFunction handle whose value is a renderer-clock time. */
export async function rendererTime(handle: { jsonValue(): Promise<unknown> }): Promise<number> {
  const value = await handle.jsonValue()
  if (typeof value !== 'number') {
    throw new Error(`expected a renderer time, got ${JSON.stringify(value)}`)
  }
  return value
}

/** One RPC from the renderer, timed on the renderer clock: the host span every row reports beside its visible end point. */
export async function rpc<T>(
  page: Page,
  method: string,
  params: unknown,
  options: { allowRefusal?: true } = {}
): Promise<{ value: T; refused: boolean; startedAt: number; hostMs: number }> {
  const answer = await page.evaluate(
    async ({ method, params }) => {
      const startedAt = performance.now()
      const reply = await window.api.runtime.call({ method, params })
      return { reply, startedAt, hostMs: performance.now() - startedAt }
    },
    { method, params }
  )
  const inResult = answer.reply.ok ? inResultRefusal(answer.reply.result) : null
  const refused = !answer.reply.ok || inResult !== null
  if (refused && !options.allowRefusal) {
    const reason = answer.reply.ok ? inResult?.refusal : answer.reply.error
    throw new Error(`${method} refused: ${JSON.stringify(reason).slice(0, 400)}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime RPC answers untyped JSON; each caller names the shape its method returns and reads optional fields defensively.
  const value = (answer.reply.ok ? answer.reply.result : answer.reply.error) as T
  return { value, refused, startedAt: answer.startedAt, hostMs: answer.hostMs }
}

/** Renderer-clock time a marker became visible, waiting up to `timeoutMs`. */
export async function markerSeenAt(
  page: Page,
  marker: string,
  timeoutMs = 120_000
): Promise<number> {
  const handle = await page
    .waitForFunction(
      (marker) => {
        if (!window.__4a) {
          throw new Error('4a visibility probe not installed')
        }
        return window.__4a.seen.get(marker) ?? false
      },
      marker,
      { timeout: timeoutMs, polling: 16 }
    )
    .catch(async (error: unknown) => {
      await page.evaluate((marker) => window.__4a?.cancel(marker), marker)
      throw new Error(
        `${marker} not visible in ${timeoutMs} ms (${await visibleChatState(page)})`,
        {
          cause: error
        }
      )
    })
  try {
    return await rendererTime(handle)
  } finally {
    await handle.dispose()
  }
}

/** One line on the chat the user sees, for timeout messages. */
export function visibleChatState(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const roots = [...document.querySelectorAll('[data-native-chat-root="true"]')]
      const root = roots.find((candidate) => candidate.checkVisibility())
      const text = root?.textContent ?? ''
      return `${roots.length} roots, visible=${Boolean(root)}, working=${root?.getAttribute('data-native-chat-working')}, tail=${JSON.stringify(text.slice(-160))}`
    })
    .catch((error: unknown) => `state unreadable: ${String(error)}`)
}

/** Gaps between visible transcript updates inside [from, to], the live-update cadence a reader sees. */
export async function mutationGaps(page: Page, from: number, to: number): Promise<number[]> {
  return page.evaluate(
    ({ from, to }) => {
      if (!window.__4a) {
        throw new Error('4a visibility probe not installed')
      }
      const times = window.__4a.mutations.filter((t) => t >= from && t <= to)
      return times.slice(1).map((time, index) => time - times[index]!)
    },
    { from, to }
  )
}

export const rendererNow = (page: Page): Promise<number> => page.evaluate(() => performance.now())

export { hostWorkMark, type HostWork } from './native-chat-4a-host-work'

/** All SQLite/journal files under the profile, so WAL growth and file growth read the same on both storage designs. */
export function storageBytes(
  userDataDir: string,
  includeHome = false
): { db: number; wal: number; total: number } {
  let db = 0
  let wal = 0
  let total = 0
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (includeHome || entry.name !== 'home') {
          visit(file)
        }
        continue
      }
      const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0
      total += size
      if (entry.name.endsWith('-wal')) {
        wal += size
      } else if (/\.(db|sqlite)$/.test(entry.name)) {
        db += size
      }
    }
  }
  visit(userDataDir)
  return { db, wal, total }
}

export type Pressure = {
  peakMainRssBytes: number
  peakAppWorkingSetBytes: number
  peakWalBytes: number
  peakTotalBytes: number
}

/** Sample memory and storage every `everyMs` until stopped; peaks only, so sampling cost stays flat. */
export function samplePressure(
  app: ElectronApplication,
  userDataDir: string,
  everyMs = 250
): () => Promise<Pressure> {
  const peak: Pressure = {
    peakMainRssBytes: 0,
    peakAppWorkingSetBytes: 0,
    peakWalBytes: 0,
    peakTotalBytes: 0
  }
  let stopped = false
  const loop = (async () => {
    while (!stopped) {
      const memory = await app
        .evaluate(({ app: electronApp }) => ({
          rss: process.memoryUsage().rss,
          workingSetKb: electronApp
            .getAppMetrics()
            .reduce((sum, metric) => sum + metric.memory.workingSetSize, 0)
        }))
        .catch(() => null)
      if (memory) {
        peak.peakMainRssBytes = Math.max(peak.peakMainRssBytes, memory.rss)
        peak.peakAppWorkingSetBytes = Math.max(
          peak.peakAppWorkingSetBytes,
          memory.workingSetKb * 1024
        )
      }
      const disk = storageBytes(userDataDir)
      peak.peakWalBytes = Math.max(peak.peakWalBytes, disk.wal)
      peak.peakTotalBytes = Math.max(peak.peakTotalBytes, disk.total)
      await new Promise((resolve) => setTimeout(resolve, everyMs))
    }
  })()
  return async () => {
    stopped = true
    await loop
    return peak
  }
}

/** Worst main-process event-loop window overlapping [fromEpochMs, toEpochMs], from the probe both arms already ship. */
export function eventLoopLag(
  userDataDir: string,
  fromEpochMs: number,
  toEpochMs: number
): { p99Ms: number; maxMs: number; windows: number } {
  const summary = summarizeEventLoopDelay(userDataDir, 'main', fromEpochMs, toEpochMs)
  return { p99Ms: summary.p99, maxMs: summary.max, windows: summary.windows }
}
