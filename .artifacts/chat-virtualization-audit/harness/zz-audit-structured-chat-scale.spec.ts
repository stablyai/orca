// DISPOSABLE AUDIT HARNESS (chat-virtualization-audit). Structured (orcad journal) lane. Not for merge.
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'
import { SUPPORTED, openStubChat, test } from './helpers/structured-claude-stub'

const OUT_DIR = process.env.AUDIT_OUT ?? path.join(os.tmpdir(), 'orca-chat-audit')
mkdirSync(OUT_DIR, { recursive: true })
const TOTAL = Number(process.env.AUDIT_STRUCT_ROWS ?? 2000)
const PER_TURN = Number(process.env.AUDIT_STRUCT_PER_TURN ?? 200)
const TOOL_BYTES = Number(process.env.AUDIT_TOOL_BYTES ?? 0)

function marker(index: number): string {
  return `AUDIT row ${String(index).padStart(6, '0')}`
}
async function memory(app: ElectronApplication, page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.send('HeapProfiler.collectGarbage')
  const heap = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number; totalSize: number }
  const perf = (await cdp.send('Performance.enable').then(() => cdp.send('Performance.getMetrics'))) as {
    metrics: { name: string; value: number }[]
  }
  await cdp.detach()
  const metric = (name: string) => perf.metrics.find((m) => m.name === name)?.value ?? null
  const main = await app.evaluate(async ({ app: electronApp }) => {
    const g = globalThis as { gc?: () => void }
    g.gc?.()
    const usage = process.memoryUsage()
    const metrics = electronApp.getAppMetrics().map((m) => ({
      type: m.type,
      kb: m.memory.workingSetSize
    }))
    return { heapUsed: usage.heapUsed, rss: usage.rss, gcExposed: typeof g.gc === 'function', metrics }
  })
  const dom = await page.evaluate(() => {
    const scroll = document.querySelector('[data-native-chat-scroll]')
    return {
      documentNodes: document.getElementsByTagName('*').length,
      transcriptNodes: scroll ? scroll.getElementsByTagName('*').length : 0,
      mountedRows: scroll ? scroll.querySelectorAll('[data-native-chat-window] > [data-index]').length : 0,
      scrollHeight: scroll instanceof HTMLElement ? scroll.scrollHeight : 0,
      clientHeight: scroll instanceof HTMLElement ? scroll.clientHeight : 0
    }
  })
  return {
    rendererHeapUsedMB: +(heap.usedSize / 1e6).toFixed(1),
    rendererJsHeapMetricMB: +((metric('JSHeapUsedSize') ?? 0) / 1e6).toFixed(1),
    domNodesMetric: metric('Nodes'),
    jsListeners: metric('JSEventListeners'),
    mainHeapUsedMB: +(main.heapUsed / 1e6).toFixed(1),
    mainRssMB: +(main.rss / 1e6).toFixed(1),
    mainGcExposed: main.gcExposed,
    processesKB: main.metrics,
    ...dom
  }
}

/** Waits until scroll geometry is unchanged for N frames. */
async function settle(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const el = document.querySelector<HTMLElement>('[data-native-chat-scroll]')
    const t0 = performance.now()
    if (!el) return 0
    let prev = ''
    let stable = 0
    for (let f = 0; f < 600 && stable < 10; f += 1) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      const g = `${el.scrollHeight}:${el.scrollTop}`
      stable = g === prev ? stable + 1 : 0
      prev = g
    }
    return performance.now() - t0
  })
}

/** Programmatic upward scroll in fixed steps; reports per-frame visual jump of a tracked row. */
async function scrollProbe(page: Page, stepPx: number, frames: number) {
  return page.evaluate(
    async ({ stepPx, frames }) => {
      const el = document.querySelector<HTMLElement>('[data-native-chat-scroll]')!
      const markerOf = (row: Element) =>
        Array.from(row.querySelectorAll('p')).find((p) => /^AUDIT row \d{6}$/.test(p.textContent?.trim() ?? ''))
      const findMarker = (text: string) =>
        Array.from(el.querySelectorAll('p')).find((p) => p.textContent?.trim() === text) ?? null
      const pickAnchor = () => {
        const box = el.getBoundingClientRect()
        const mid = box.top + box.height / 2
        let best: { text: string; top: number } | null = null
        for (const row of Array.from(el.querySelectorAll('[data-native-chat-window] > [data-index]'))) {
          const m = markerOf(row)
          if (!m) continue
          const top = m.getBoundingClientRect().top
          if (top < box.top + 20 || top > box.bottom - 20) continue
          if (!best || Math.abs(top - mid) < Math.abs(best.top - mid)) best = { text: m.textContent!.trim(), top }
        }
        return best
      }
      const frameMs: number[] = []
      const jumps: { frame: number; jumpPx: number; scrollTop: number; scrollHeight: number; anchor: string }[] = []
      const longTasks: number[] = []
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push(e.duration)
      })
      try {
        po.observe({ entryTypes: ['longtask'] })
      } catch {}
      let anchor = pickAnchor()
      let last = performance.now()
      let reachedTopAt: number | null = null
      const heightSeries: number[] = []
      for (let f = 0; f < frames; f += 1) {
        const prevScrollTop = el.scrollTop
        const expected = Math.min(stepPx, prevScrollTop)
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: -stepPx, bubbles: true }))
        el.scrollTop = prevScrollTop - stepPx
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
        const now = performance.now()
        frameMs.push(now - last)
        last = now
        heightSeries.push(el.scrollHeight)
        if (el.scrollTop === 0 && reachedTopAt === null) reachedTopAt = f
        if (anchor) {
          const node = findMarker(anchor.text)
          if (node) {
            const top = node.getBoundingClientRect().top
            const jump = top - anchor.top - expected
            if (Math.abs(jump) > 2) {
              jumps.push({ frame: f, jumpPx: Math.round(jump), scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, anchor: anchor.text })
            }
          }
        }
        anchor = pickAnchor()
      }
      po.disconnect()
      const sorted = [...frameMs].sort((a, b) => a - b)
      const q = (p: number) => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1)
      return {
        frames,
        stepPx,
        frameMsP50: q(0.5),
        frameMsP95: q(0.95),
        frameMsMax: q(0.999),
        framesOver33ms: frameMs.filter((m) => m > 33).length,
        longTasks: longTasks.length,
        longTaskMaxMs: Math.round(Math.max(0, ...longTasks)),
        jumpsOver2px: jumps.length,
        worstJumps: [...jumps].sort((a, b) => Math.abs(b.jumpPx) - Math.abs(a.jumpPx)).slice(0, 8),
        reachedTopAtFrame: reachedTopAt,
        endScrollTop: el.scrollTop,
        endScrollHeight: el.scrollHeight
      }
    },
    { stepPx, frames }
  )
}

/** Jump straight to top (scrollbar drag / Home) and record what the reader sees for ~4s. */
async function jumpToTopProbe(page: Page) {
  return page.evaluate(async () => {
    const el = document.querySelector<HTMLElement>('[data-native-chat-scroll]')!
    const topMarker = () => {
      const box = el.getBoundingClientRect()
      for (const p of Array.from(el.querySelectorAll('p'))) {
        const t = p.textContent?.trim() ?? ''
        if (!/^AUDIT row \d{6}$/.test(t)) continue
        const r = p.getBoundingClientRect()
        if (r.top >= box.top - 4 && r.top < box.bottom) return t
      }
      return null
    }
    const before = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, top: topMarker() }
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    const t0 = performance.now()
    el.scrollTop = 0
    const samples: { t: number; scrollTop: number; scrollHeight: number; top: string | null }[] = []
    let lastKey = ''
    while (performance.now() - t0 < 4000) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      const s = { t: Math.round(performance.now() - t0), scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, top: topMarker() }
      const key = `${s.scrollTop}:${s.scrollHeight}:${s.top}`
      if (key !== lastKey) samples.push(s)
      lastKey = key
    }
    return { before, samples: samples.slice(0, 40) }
  })
}


/** Stationary reader near the head: one write into the prefetch band, then trace each frame. */
async function prependTrace(page: Page, landAt: number) {
  return page.evaluate(async ({ landAt, postPaintEnv }) => {
    const process = { env: { AUDIT_POSTPAINT: postPaintEnv } }
    const el = document.querySelector<HTMLElement>('[data-native-chat-scroll]')!
    const markers = () => {
      const box = el.getBoundingClientRect()
      const out: { t: string; top: number }[] = []
      for (const p of Array.from(el.querySelectorAll('p'))) {
        const t = p.textContent?.trim() ?? ''
        if (!/^AUDIT row \d{6}$/.test(t)) continue
        const r = p.getBoundingClientRect()
        if (r.top >= box.top && r.top < box.bottom) out.push({ t, top: Math.round(r.top - box.top) })
      }
      return out
    }
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
    el.scrollTop = landAt
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
    const first = markers()
    const anchor = first[Math.floor(first.length / 2)] ?? first[0]
    const t0 = performance.now()
    const frames: unknown[] = []
    let lastKey = ''
    const postPaint = process.env.AUDIT_POSTPAINT === '1'
    while (performance.now() - t0 < 2500) {
      await new Promise<void>((r) =>
        requestAnimationFrame(() => {
          if (!postPaint) return r()
          // Queued from rAF: runs after this frame's layout, ResizeObserver and paint.
          const ch = new MessageChannel()
          ch.port1.onmessage = () => r()
          ch.port2.postMessage(0)
        })
      )
      const now = markers()
      const a = now.find((m) => m.t === anchor?.t)
      const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-native-chat-window] > [data-index]'))
      const s = {
        t: Math.round(performance.now() - t0),
        scrollTop: Math.round(el.scrollTop),
        scrollHeight: el.scrollHeight,
        anchorTop: a ? a.top : null,
        firstVisible: now[0]?.t ?? null,
        mounted: rows.length,
        firstIdx: rows[0]?.dataset.index
      }
      const key = JSON.stringify({ ...s, t: 0 })
      if (key !== lastKey) frames.push(s)
      lastKey = key
    }
    return { anchor, frames: frames.slice(0, 30) }
  }, { landAt, postPaintEnv: process.env.AUDIT_POSTPAINT ?? '0' })
}


test('audit structured lane scale', async ({ orcaPage, electronApp, claudeStub }) => {
  test.skip(!SUPPORTED, 'POSIX only')
  test.setTimeout(1_800_000)
  const result: Record<string, unknown> = { total: TOTAL, perTurn: PER_TURN, toolBytes: TOOL_BYTES }
  const chat = await openStubChat(orcaPage, claudeStub.command)
  await orcaPage.waitForTimeout(2_000)
  result.baseline = await memory(electronApp, orcaPage)
  const tSeed = Date.now()
  const turnMs: number[] = []
  for (let start = 0; start < TOTAL; start += PER_TURN) {
    const t0 = Date.now()
    await orcaPage.evaluate(() => {
      const w = window as unknown as { __auditFrames: number[]; __auditStop: boolean }
      w.__auditFrames = []
      w.__auditStop = false
      let last = performance.now()
      const tick = () => {
        const now = performance.now()
        w.__auditFrames.push(now - last)
        last = now
        if (!w.__auditStop) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await chat.composer.click()
    await orcaPage.keyboard.type(`bulk:${start}:${Math.min(PER_TURN, TOTAL - start)}:${TOOL_BYTES}`)
    await orcaPage.keyboard.press('Enter')
    const last = Math.min(TOTAL, start + PER_TURN) - 1
    await expect(orcaPage.getByText(marker(last), { exact: true })).toBeAttached({ timeout: 300_000 })
    turnMs.push(Date.now() - t0)
    const fstats = await orcaPage.evaluate(() => {
      const w = window as unknown as { __auditFrames: number[]; __auditStop: boolean }
      w.__auditStop = true
      const f = [...w.__auditFrames].sort((a, b) => a - b)
      const sum = f.reduce((a, b) => a + b, 0)
      return {
        frames: f.length,
        p50: Math.round(f[Math.floor(f.length / 2)]),
        p95: Math.round(f[Math.floor(f.length * 0.95)]),
        max: Math.round(f.at(-1) ?? 0),
        over50: f.filter((x) => x > 50).length,
        blockedMs: Math.round(f.filter((x) => x > 50).reduce((a, b) => a + b, 0)),
        wallMs: Math.round(sum)
      }
    })
    ;(result.turnFrames ??= [] as unknown[]) as unknown[]
    ;(result.turnFrames as unknown[]).push(fstats)
    if (start === 0 || start + PER_TURN >= TOTAL) { if (PER_TURN < 10 && start !== 0) { /* skip */ } else
      await orcaPage.screenshot({ path: path.join(OUT_DIR, `structured-turn-${start}.png`) })
    }
  }
  result.seedMs = Date.now() - tSeed
  result.turnMs = turnMs
  await settle(orcaPage)
  result.liveAfterSeed = await memory(electronApp, orcaPage)
  // Cold open: reload the renderer and reopen the chat tab from the host journal.
  const tabId = await chat.tab.getAttribute('data-tab-id')
  await orcaPage.reload()
  await orcaPage.waitForFunction(() => Boolean(window.__store), null, { timeout: 60_000 })
  await orcaPage.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true, null, { timeout: 60_000 })
  await orcaPage.waitForTimeout(3_000)
  result.reloadedBaseline = await memory(electronApp, orcaPage)
  await orcaPage.screenshot({ path: path.join(OUT_DIR, 'structured-after-reload.png') })
  const tab = orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
  const tOpen = Date.now()
  await tab.click()
  await expect(orcaPage.getByText(marker(TOTAL - 1), { exact: true })).toBeAttached({ timeout: 120_000 })
  result.coldOpenToLastRowMs = Date.now() - tOpen
  await settle(orcaPage)
  result.coldOpenToSettledMs = Date.now() - tOpen
  result.afterColdOpen = await memory(electronApp, orcaPage)
  await orcaPage.screenshot({ path: path.join(OUT_DIR, 'structured-cold-open.png') })
  result.coldOpenView = await orcaPage.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-native-chat-scroll]')!
    const ps = Array.from(el.querySelectorAll('p')).map((p) => p.textContent?.trim() ?? '').filter((t) => /^AUDIT row \d{6}$/.test(t))
    return { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, first: ps[0], last: ps.at(-1), mountedMarkers: ps.length, text: el.innerText.slice(0, 600) }
  })
  await orcaPage.locator('[data-native-chat-scroll]').hover()
  await orcaPage.mouse.wheel(0, -800)
  await orcaPage.waitForTimeout(400)
  result.scrollUp = await scrollProbe(orcaPage, 300, 400)
  await orcaPage.screenshot({ path: path.join(OUT_DIR, 'structured-after-scrollup.png') })
  await settle(orcaPage)
  result.jumpToTop = await jumpToTopProbe(orcaPage)
  await settle(orcaPage)
  result.scrollUpDeep = await scrollProbe(orcaPage, 600, 900)
  await settle(orcaPage)
  result.afterDeep = await memory(electronApp, orcaPage)
  result.loadedAfterDeep = await orcaPage.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-native-chat-scroll]')!
    const ps = Array.from(el.querySelectorAll('p')).map((p) => p.textContent?.trim() ?? '').filter((t) => /^AUDIT row \d{6}$/.test(t))
    return { firstMountedMarker: ps[0] ?? null, scrollHeight: el.scrollHeight }
  })
  writeFileSync(path.join(OUT_DIR, `structured-${TOTAL}-${TOOL_BYTES}.json`), JSON.stringify(result, null, 2))
})
