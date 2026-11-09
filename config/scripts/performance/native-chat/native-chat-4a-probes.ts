// Arm-neutral 4a probes: renderer-clock end points, host CPU/event-loop work, memory and on-disk storage, read from outside product code.
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Performance as NodePerformance } from 'node:perf_hooks'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { retryTransientMainEvaluate } from '../../../../tests/e2e/helpers/electron-main-evaluate-retry'
import { summarizeEventLoopDelay } from '../../../../tests/e2e/helpers/event-loop-delay-report'

export type RpcAnswer<T = unknown> = { ok: true; result: T } | { ok: false; error: unknown }

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
      const reply = (await window.api.runtime.call({ method, params })) as RpcAnswer
      return { reply, startedAt, hostMs: performance.now() - startedAt }
    },
    { method, params }
  )
  // Some writes (create, fork) refuse inside a successful call: `{ ok: false, refusal }`.
  const result = answer.reply.ok
    ? (answer.reply.result as { ok?: unknown; refusal?: unknown })
    : null
  const inResult = result?.ok === false && 'refusal' in result
  const refused = !answer.reply.ok || inResult
  if (refused && !options.allowRefusal) {
    const reason = answer.reply.ok ? result?.refusal : answer.reply.error
    throw new Error(`${method} refused: ${JSON.stringify(reason).slice(0, 400)}`)
  }
  const value = (answer.reply.ok ? answer.reply.result : answer.reply.error) as T
  return { value, refused, startedAt: answer.startedAt, hostMs: answer.hostMs }
}

/** Install once per page: records when text first appears in the chat root and every transcript mutation batch. */
export async function installVisibilityProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = window as unknown as {
      __4a?: { seen: Map<string, number>; mutations: number[]; watch: Set<string> }
    }
    if (probe.__4a) {
      return
    }
    const state = {
      seen: new Map<string, number>(),
      mutations: [] as number[],
      watch: new Set<string>()
    }
    probe.__4a = state
    const check = (): void => {
      const now = performance.now()
      state.mutations.push(now)
      if (state.mutations.length > 200_000) {
        state.mutations.splice(0, 100_000)
      }
      if (state.watch.size === 0) {
        return
      }
      // Text still in the composer is not sent: count only occurrences outside it.
      // Hidden tabs can stay mounted; only the chat the user sees counts.
      const root = [...document.querySelectorAll('[data-native-chat-root="true"]')].find(
        (candidate) => candidate.checkVisibility()
      )
      const text = root?.textContent ?? ''
      const draft = root?.querySelector('[role="textbox"]')?.textContent ?? ''
      const count = (value: string, marker: string): number => value.split(marker).length - 1
      for (const marker of state.watch) {
        if (count(text, marker) > count(draft, marker)) {
          state.seen.set(marker, now)
          state.watch.delete(marker)
        }
      }
    }
    new MutationObserver(check).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true
    })
  })
}

export async function watchMarkers(page: Page, markers: string[]): Promise<void> {
  await page.evaluate((markers) => {
    const state = (window as unknown as { __4a: { watch: Set<string>; seen: Map<string, number> } })
      .__4a
    for (const marker of markers) {
      state.seen.delete(marker)
      state.watch.add(marker)
    }
  }, markers)
}

/** Renderer-clock time a marker became visible, waiting up to `timeoutMs`. */
export async function markerSeenAt(
  page: Page,
  marker: string,
  timeoutMs = 120_000
): Promise<number> {
  const handle = await page
    .waitForFunction(
      (marker) =>
        (window as unknown as { __4a: { seen: Map<string, number> } }).__4a.seen.get(marker) ??
        false,
      marker,
      { timeout: timeoutMs, polling: 16 }
    )
    .catch(async (error: unknown) => {
      throw new Error(
        `${marker} not visible in ${timeoutMs} ms (${await visibleChatState(page)})`,
        {
          cause: error
        }
      )
    })
  return (await handle.jsonValue()) as number
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
      const times = (window as unknown as { __4a: { mutations: number[] } }).__4a.mutations.filter(
        (t) => t >= from && t <= to
      )
      return times.slice(1).map((time, index) => time - times[index]!)
    },
    { from, to }
  )
}

export const rendererNow = (page: Page): Promise<number> => page.evaluate(() => performance.now())

export type HostWork = { cpuMs: number; mainThreadActiveMs: number; offMainThreadCpuMs: number }

/** Process CPU covers the main thread and its storage workers; main-thread ELU separates the two. */
export async function hostWorkMark(app: ElectronApplication): Promise<() => Promise<HostWork>> {
  // Main-process callbacks see Node's performance, not the DOM one this file is typed against.
  const start = await retryTransientMainEvaluate(() =>
    app.evaluate(() => ({
      cpu: process.cpuUsage(),
      elu: (performance as unknown as NodePerformance).eventLoopUtilization()
    }))
  )
  return async () => {
    const delta = await retryTransientMainEvaluate(() =>
      app.evaluate((_electron, start) => {
        const node = performance as unknown as NodePerformance
        return {
          cpu: process.cpuUsage(start.cpu),
          elu: node.eventLoopUtilization(node.eventLoopUtilization(), start.elu)
        }
      }, start)
    )
    const cpuMs = (delta.cpu.user + delta.cpu.system) / 1000
    return {
      cpuMs,
      mainThreadActiveMs: delta.elu.active,
      offMainThreadCpuMs: Math.max(0, cpuMs - delta.elu.active)
    }
  }
}

/** All SQLite/journal files under the profile, so WAL growth and file growth read the same on both storage designs. */
export function storageBytes(userDataDir: string): { db: number; wal: number; total: number } {
  let db = 0
  let wal = 0
  let total = 0
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'home') {
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
