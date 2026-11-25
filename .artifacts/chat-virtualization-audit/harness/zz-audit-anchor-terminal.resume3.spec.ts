// DISPOSABLE AUDIT HARNESS (chat-virtualization-audit). Not for merge.
// Measures native chat transcript scale: open latency, IPC bytes, DOM nodes, heap, scroll frames,
// older-history prepend anchoring and visual jumps. Scenario via AUDIT_SCEN="kind:count[,kind:count]".
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import type { GlobalSettings } from '../../../../src/shared/settings/global-settings-types'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from '../../desktop/renderer-probes/store'
import { waitForActivePanePtyId } from '../../terminal/input/terminal'
import { waitForActivePaneHookDescriptor } from '../../terminal/input/terminal-active-pane'
import { waitForActiveTerminalManager } from '../../terminal/layout/terminal-pane-operations'
import { waitForPtyShellEcho } from '../../terminal/lifecycle/terminal-pty-readiness'

import { anchorWheelPages } from './zz-audit-anchor-gestures'

const WIDTH = Number(process.env.AUDIT_WIDTH ?? 1280)
const FONT = Number(process.env.AUDIT_FONT ?? 13)
const OUT_DIR = process.env.AUDIT_OUT ?? path.join(os.tmpdir(), 'orca-chat-audit')
mkdirSync(OUT_DIR, { recursive: true })

type Kind = 'text' | 'tools' | 'control'
const SCENARIOS: { kind: Kind; count: number }[] = (process.env.AUDIT_SCEN ?? 'control:0,text:2000')
  .split(',')
  .map((entry) => {
    const [kind, count] = entry.split(':')
    return { kind: kind as Kind, count: Number(count) }
  })
const TOOL_OUTPUT_BYTES = Number(process.env.AUDIT_TOOL_BYTES ?? 20_000)

function marker(index: number): string {
  return `AUDIT row ${String(index).padStart(6, '0')}`
}

function writeTranscript(file: string, kind: Kind, count: number, sessionId: string): void {
  writeFileSync(file, '')
  const startedAt = Date.now() - count * 1_000
  let buffer: string[] = []
  const flush = (): void => {
    appendFileSync(file, buffer.join(''))
    buffer = []
  }
  const filler = 'x'.repeat(78)
  const bigOutput = Array.from(
    { length: Math.ceil(TOOL_OUTPUT_BYTES / 80) },
    (_, line) => `${String(line).padStart(5, '0')} ${filler}`
  ).join('\n')
  for (let index = 0; index < count; index += 1) {
    const ts = new Date(startedAt + index * 1_000).toISOString()
    const isUser = index % 2 === 0
    const body = Array.from(
      { length: 1 + (index % 7) },
      (_u, line) =>
        `Paragraph ${line + 1} of ${marker(index)}: ${'lorem ipsum dolor sit amet '.repeat(1 + ((index * 7 + line) % 9))}`
    ).join('\n\n')
    let content: unknown[] = [{ type: 'text', text: `${marker(index)}\n\n${body}` }]
    if (kind === 'tools' && !isUser) {
      const toolId = `toolu_${index}`
      content = [
        { type: 'text', text: `${marker(index)}\n\nRunning a command.\n\n\`\`\`ts\nconst a = ${index}\n\`\`\`` },
        { type: 'tool_use', id: toolId, name: 'Bash', input: { command: `cat file-${index}.log` } }
      ]
      buffer.push(
        `${JSON.stringify({
          sessionId,
          uuid: `${sessionId}-${index}`,
          timestamp: ts,
          type: 'assistant',
          message: { role: 'assistant', model: 'claude-opus-4', content }
        })}\n`
      )
      buffer.push(
        `${JSON.stringify({
          sessionId,
          uuid: `${sessionId}-${index}-r`,
          timestamp: ts,
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolId, content: bigOutput }]
          }
        })}\n`
      )
    } else {
      buffer.push(
        `${JSON.stringify({
          sessionId,
          uuid: `${sessionId}-${index}`,
          timestamp: ts,
          type: isUser ? 'user' : 'assistant',
          message: { role: isUser ? 'user' : 'assistant', model: 'claude-opus-4', content }
        })}\n`
      )
    }
    if (buffer.length > 2_000) {
      flush()
    }
  }
  flush()
}

async function enableNativeChat(page: Page): Promise<void> {
  await page.evaluate(async (FONT) => {
    const next = await window.api.settings.set({ nativeChatProviders: { claude: true, codex: true }, nativeChatAppearance: { fontSize: FONT, matchTerminalInterface: false } })
    window.__store?.setState({ settings: next as GlobalSettings })
  }, FONT)
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
      const shiftMoves: number[] = []
      let shiftCount = 0
      let shiftScore = 0
      const lso = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as { value: number; sources?: { previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[] }[]) {
          shiftCount += 1
          shiftScore += e.value
          for (const src of e.sources ?? []) shiftMoves.push(Math.round(src.currentRect.top - src.previousRect.top))
        }
      })
      lso.observe({ type: 'layout-shift', buffered: false })
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
      await new Promise<void>((r) => setTimeout(r, 50))
      lso.disconnect()
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
        paintedLayoutShiftCount: shiftCount,
        paintedLayoutShiftScore: +shiftScore.toFixed(3),
        paintedShiftMovesPx: shiftMoves.sort((a, b) => Math.abs(b) - Math.abs(a)).slice(0, 10),
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
    const rowDump = () =>
      Array.from(el.querySelectorAll<HTMLElement>('[data-native-chat-window] > [data-index]')).map((row) => ({
        i: Number(row.dataset.index),
        h: Math.round(row.getBoundingClientRect().height),
        top: Math.round(row.getBoundingClientRect().top - el.getBoundingClientRect().top),
        txt: (row.innerText ?? '').replace(/\s+/g, ' ').slice(0, 70)
      }))
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
    el.scrollTop = landAt
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
    const rowsBefore = rowDump()
    ;(window as unknown as { __auditLog?: unknown[] }).__auditLog = []
    const first = markers()
    const anchor = first[Math.floor(first.length / 2)] ?? first[0]
    const shifts: { t: number; value: number; moves: number[] }[] = []
    const lso = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { startTime: number; value: number; sources?: { previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[] }[]) {
        shifts.push({
          t: Math.round(e.startTime - t0),
          value: +e.value.toFixed(4),
          moves: (e.sources ?? []).map((src) => Math.round(src.currentRect.top - src.previousRect.top))
        })
      }
    })
    lso.observe({ type: 'layout-shift', buffered: false })
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
    lso.disconnect()
    return { anchor, frames: frames.slice(0, 30), paintedLayoutShifts: shifts, rowsBefore, rowsAfter: rowDump(), auditLog: ((window as unknown as { __auditLog?: unknown[] }).__auditLog ?? []).slice(0, 60) }
  }, { landAt, postPaintEnv: process.env.AUDIT_POSTPAINT ?? '0' })
}

for (const scenario of SCENARIOS) {
  test(`audit scale ${scenario.kind}:${scenario.count}`, async ({ orcaPage, electronApp }) => {
    test.setTimeout(900_000)
    const result: Record<string, unknown> = { scenario, toolOutputBytes: TOOL_OUTPUT_BYTES, loadAverage: os.loadavg(), cpus: os.cpus().length, at: new Date().toISOString(), viewport: { width: WIDTH, height: 900 } }
    await orcaPage.setViewportSize({ width: WIDTH, height: 900 })
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      if (state.sidebarOpen) state.toggleSidebar()
      state.setRightSidebarOpen(false)
    })
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)
    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    await orcaPage.waitForTimeout(3_000)
    const rafCadence = await orcaPage.evaluate(async () => {
      const ts: number[] = []
      for (let i = 0; i < 61; i += 1) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
        ts.push(performance.now())
      }
      return +((ts[60] - ts[0]) / 60).toFixed(2)
    })
    result.idleRafMs = rafCadence
    result.baseline = await memory(electronApp, orcaPage)
    if (scenario.kind === 'control') {
      await orcaPage.waitForTimeout(5_000)
      result.baselineAfter5s = await memory(electronApp, orcaPage)
      writeFileSync(path.join(OUT_DIR, `control.json`), JSON.stringify(result, null, 2))
      return
    }

    const sessionId = `audit-${randomUUID()}`
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-chat-audit-'))
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`)
    const tGen = Date.now()
    writeTranscript(transcriptPath, scenario.kind, scenario.count, sessionId)
    result.fileMB = +(statSync(transcriptPath).size / 1e6).toFixed(2)
    result.genMs = Date.now() - tGen
    try {
      if (process.env.AUDIT_MODE === 'raw') {
        result.raw = await electronApp.evaluate(async (_electron, args) => {
          const require = process.getBuiltinModule('node:module').createRequire(args.modulePath)
          const { readNativeChatTranscriptTail } = require(args.modulePath)
          const data: unknown[] = []
          for (const loaded of [300, 8500, 25000, 49000]) {
            const t0 = performance.now()
            const tail = await readNativeChatTranscriptTail({ agent: 'claude', sessionId: args.sessionId, filePath: args.transcriptPath, limit: loaded, sourceOrder: true })
            const tailMs = performance.now() - t0
            if ('error' in tail) throw new Error(tail.error)
            const t1 = performance.now()
            const page = await readNativeChatTranscriptTail({ agent: 'claude', sessionId: args.sessionId, filePath: args.transcriptPath, limit: 200, beforeOffset: tail.beforeOffset, sourceOrder: true })
            const pageMs = performance.now() - t1
            data.push({ loaded, tailMs, tailBytes: Buffer.byteLength(JSON.stringify(tail)), tailMessages: tail.messages.length, cursorPageMs: pageMs, cursorBytes: Buffer.byteLength(JSON.stringify(page)), cursorMessages: 'messages' in page ? page.messages.length : -1 })
          }
          return data
        }, { modulePath: path.join(process.cwd(), '.artifacts/chat-virtualization-audit/harness/tail-reader-bundled.cjs'), sessionId, transcriptPath })
      }
      await enableNativeChat(orcaPage)
      // IPC cost of the initial window and of successive older pages (each re-reads limit rows).
      result.ipc = await orcaPage.evaluate(
        async ({ sessionId, transcriptPath }) => {
          const rows: { limit: number; ms: number; bytes: number; messages: number }[] = []
          for (const limit of [300, 500, 700, 1100, 2100]) {
            const t0 = performance.now()
            const r = await window.api.nativeChat.readSession('claude', sessionId, limit, transcriptPath)
            const ms = performance.now() - t0
            const bytes = JSON.stringify(r).length
            rows.push({ limit, ms: Math.round(ms), bytes, messages: 'messages' in r ? r.messages.length : -1 })
          }
          return rows
        },
        { sessionId, transcriptPath }
      )
      await orcaPage.evaluate(
        ({ paneKey, worktreeId, sessionId, transcriptPath }) => {
          window.__store
            ?.getState()
            .setAgentStatus(
              paneKey,
              { state: 'done', prompt: 'audit', agentType: 'claude' },
              'Claude',
              undefined,
              { worktreeId },
              { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
            )
        },
        { paneKey: descriptor.paneKey, worktreeId: descriptor.worktreeId, sessionId, transcriptPath }
      )
      await orcaPage.evaluate(() => {
        const w = window as unknown as { __openTrace: unknown[] }
        w.__openTrace = []
        const t0 = performance.now()
        const tick = () => {
          // Queued from rAF: sample after this frame paints.
          const ch = new MessageChannel()
          ch.port1.onmessage = () => {
            const el = document.querySelector<HTMLElement>('[data-native-chat-scroll]')
            if (el) {
              const box = el.getBoundingClientRect()
              const first = Array.from(el.querySelectorAll('p')).find((p) => {
                const r = p.getBoundingClientRect()
                return /^AUDIT row \d{6}$/.test(p.textContent?.trim() ?? '') && r.top >= box.top && r.top < box.bottom
              })
              w.__openTrace.push({
                t: Math.round(performance.now() - t0),
                scrollTop: Math.round(el.scrollTop),
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                firstVisible: first?.textContent?.trim() ?? null
              })
            }
            if (performance.now() - t0 < 2500) requestAnimationFrame(tick)
          }
          ch.port2.postMessage(0)
        }
        requestAnimationFrame(tick)
      })
      const tOpen = Date.now()
      await orcaPage.evaluate(
        ({ tabId, worktreeId }) => {
          const state = window.__store!.getState()
          const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
            (t) => t.contentType === 'terminal' && t.entityId === tabId
          )
          state.toggleTabViewMode(tab!.id)
        },
        { tabId, worktreeId: descriptor.worktreeId }
      )
      const lastIndex = scenario.count - 1
      await expect(orcaPage.getByText(marker(lastIndex), { exact: true })).toBeAttached({ timeout: 120_000 })
      result.openToLastRowMs = Date.now() - tOpen
      result.settleMs = Math.round(await settle(orcaPage))
      result.openToSettledMs = Date.now() - tOpen
      await orcaPage.waitForTimeout(2600)
      result.openTrace = await orcaPage.evaluate(() => {
        const all = (window as unknown as { __openTrace: { scrollTop: number; scrollHeight: number; firstVisible: string | null }[] }).__openTrace
        const out: unknown[] = []
        let last = ''
        for (const s of all) {
          const k = `${s.scrollTop}:${s.scrollHeight}:${s.firstVisible}`
          if (k !== last) out.push(s)
          last = k
        }
        return out.slice(0, 25)
      })
      result.afterOpen = await memory(electronApp, orcaPage)
      result.chatViewport = await orcaPage.locator('[data-native-chat-scroll]').evaluate((root) => ({ width: root.clientWidth, height: root.clientHeight, fontSize: getComputedStyle(root.querySelector('p') ?? root).fontSize }))
      result.atEnd = await orcaPage.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-native-chat-scroll]')!
        return { distanceFromEnd: el.scrollHeight - el.clientHeight - el.scrollTop }
      })

      if (process.env.AUDIT_MODE === 'raw') return

      // Leave the end with a real wheel so the transcript detaches like a reader would.
      await orcaPage.locator('[data-native-chat-scroll]').hover()
      await orcaPage.mouse.wheel(0, -800)
      await orcaPage.waitForTimeout(400)
      if (process.env.AUDIT_MODE === 'matrix') {
        result.gestures = await anchorWheelPages(orcaPage)
        await orcaPage.screenshot({ path: path.join(OUT_DIR, 'after-wheel-pages.png') })
        return
      }
      if (process.env.AUDIT_MODE === 'depth') {
        result.ipcDeep = await orcaPage.evaluate(
          async ({ sessionId, transcriptPath }) => {
            const rows: { limit: number; ms: number; bytes: number }[] = []
            for (const limit of [5_000, 10_000, 25_000, 50_000]) {
              const t0 = performance.now()
              const r = await window.api.nativeChat.readSession('claude', sessionId, limit, transcriptPath)
              rows.push({ limit, ms: Math.round(performance.now() - t0), bytes: JSON.stringify(r).length })
            }
            return rows
          },
          { sessionId, transcriptPath }
        )
        const pages: { page: number; ms: number; longTaskMs: number; scrollHeight: number }[] = []
        const pageCount = Number(process.env.AUDIT_PAGES ?? 60)
        for (let page = 1; page <= pageCount; page += 1) {
          const r = await orcaPage.evaluate(async () => {
            const el = document.querySelector<HTMLElement>('[data-native-chat-scroll]')!
            const lt: number[] = []
            const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => lt.push(e.duration)))
            po.observe({ entryTypes: ['longtask'] })
            const h0 = el.scrollHeight
            el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
            el.scrollTop = 0
            const t0 = performance.now()
            while (el.scrollHeight === h0 && performance.now() - t0 < 30_000) {
              await new Promise<void>((res) => requestAnimationFrame(() => res()))
            }
            const ms = performance.now() - t0
            po.disconnect()
            return { ms: Math.round(ms), longTaskMs: Math.round(lt.reduce((a, b) => a + b, 0)), scrollHeight: el.scrollHeight }
          })
          pages.push({ page, ...r })
          if (page % 10 === 0) {
            ;(result as Record<string, unknown>)[`memAtPage${page}`] = await memory(electronApp, orcaPage)
          }
        }
        result.pages = pages
        return
      }
      if (process.env.AUDIT_MODE === 'trace') {
        const traces: unknown[] = []
        for (let i = 0; i < Number(process.env.AUDIT_TRACES ?? 4); i += 1) {
          await orcaPage.evaluate(() => {
            const el = document.querySelector<HTMLElement>('[data-native-chat-scroll]')!
            el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
            el.scrollTop = 3000
          })
          await settle(orcaPage)
          traces.push(await prependTrace(orcaPage, 200))
          await settle(orcaPage)
        }
        result.prependTraces = traces
        return
      }
      // Phase 1: steady upward reading (300px/frame ~ fast trackpad) for 400 frames.
      result.scrollUp = await scrollProbe(orcaPage, 300, 400)
      await settle(orcaPage)
      result.afterScrollUp = await memory(electronApp, orcaPage)
      // Phase 2: drag/Home to top and watch prepends.
      result.jumpToTop = await jumpToTopProbe(orcaPage)
      await settle(orcaPage)
      // Phase 3: keep scrolling up hard through many pages.
      result.scrollUpDeep = await scrollProbe(orcaPage, 600, 900)
      await settle(orcaPage)
      result.afterDeep = await memory(electronApp, orcaPage)
      result.loadedRowsAfterDeep = await orcaPage.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-native-chat-scroll]')!
        const ps = Array.from(el.querySelectorAll('p'))
          .map((p) => p.textContent?.trim() ?? '')
          .filter((t) => /^AUDIT row \d{6}$/.test(t))
        return { firstMountedMarker: ps[0] ?? null, scrollHeight: el.scrollHeight }
      })
    } finally {
      writeFileSync(
        path.join(OUT_DIR, `${scenario.kind}-${scenario.count}.json`),
        JSON.stringify(result, null, 2)
      )
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
