// Disposable UX evidence: trusted wheel input; no scrollTop writes.
import type { Page } from '@stablyai/playwright-test'

export async function anchorWheelPages(page: Page, pages = 3) {
  const scroll = page.locator('[data-native-chat-scroll]')
  const results: unknown[] = []
  const settle = () => scroll.evaluate(async (root) => {
    let prior = '', stable = 0
    for (let frame = 0; frame < 180 && stable < 2; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const geometry = `${root.scrollTop}:${root.scrollHeight}`
      stable = geometry === prior ? stable + 1 : 0
      prior = geometry
    }
  })
  for (let landing = 0; landing < pages; landing++) {
    const box = await scroll.boundingBox()
    if (!box) throw new Error('Transcript is hidden')
    await scroll.hover({ position: { x: Math.min(80, box.width / 2), y: Math.min(80, box.height / 2) } })
    const approach: unknown[] = []
    for (let step = 0; step < 2000; step++) {
      const position = await scroll.evaluate((root) => root.scrollTop)
      if (position >= 610 && position <= 800) break
      await page.mouse.wheel(0, Math.max(-600, Math.min(600, 750 - position)))
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const after = await scroll.evaluate((root) => root.scrollTop)
      approach.push({ before: position, after })
      if (approach.length > 5 && approach.slice(-5).every((entry: any) => Math.abs(entry.before - entry.after) < 1)) throw new Error(`Trusted wheel does not move transcript: ${JSON.stringify(approach.slice(-5))}`)
    }
    await settle()
    const before = await scroll.evaluate((root) => ({ top: root.scrollTop, height: root.scrollHeight }))
    if (before.top < 610) throw new Error(`Reader failed to park outside prefetch band: ${before.top}`)
    await scroll.evaluate((root) => {
      const viewport = root.getBoundingClientRect()
      const markers = Array.from(root.querySelectorAll('p')).filter((node) => (node.textContent ?? '').includes('AUDIT row '))
      const marker = markers.filter((node) => {
        const rect = node.getBoundingClientRect()
        return rect.bottom > viewport.top && rect.top < viewport.bottom
      }).sort((left, right) => Math.abs(left.getBoundingClientRect().top - viewport.top) - Math.abs(right.getBoundingClientRect().top - viewport.top))[0]
      if (!marker) throw new Error('No stable visible message marker')
      const text = marker.textContent!.trim()
      const trace = {
        active: true, text, baseline: marker.getBoundingClientRect().top - viewport.top,
        prefixes: [0], requestedPrefixes: [0], frames: [] as unknown[], shifts: [] as unknown[],
        finish: () => {}
      }
      const wheel = (event: WheelEvent) => {
        if (event.isTrusted) trace.prefixes.push(trace.prefixes.at(-1)! - event.deltaY)
      }
      root.addEventListener('wheel', wheel, { passive: true })
      const observer = new PerformanceObserver((list) => {
        for (const event of list.getEntries()) {
          const shift = event as PerformanceEntry & { value: number }
          trace.shifts.push({ at: shift.startTime, value: shift.value })
        }
      })
      observer.observe({ type: 'layout-shift' })
      trace.finish = () => { trace.active = false; root.removeEventListener('wheel', wheel); observer.disconnect() }
      Object.assign(window, { __anchorGestureTrace: trace })
      const sample = () => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => {
          const current = Array.from(root.querySelectorAll('p')).find((node) => node.textContent?.trim() === text)
          const row = current?.closest('[data-native-chat-window] > [data-index]')
          const top = root.getBoundingClientRect().top
          trace.frames.push({
            at: performance.now(), content: current ? current.getBoundingClientRect().top - top : null,
            sameNode: current === marker, slot: row ? row.getBoundingClientRect().top - top : null,
            prefixes: [...trace.requestedPrefixes], rawPrefixes: [...trace.prefixes], scrollTop: root.scrollTop, height: root.scrollHeight
          })
          channel.port1.close(); channel.port2.close()
          if (trace.active) requestAnimationFrame(sample)
        }
        channel.port2.postMessage(0)
      }
      requestAnimationFrame(sample)
    })
    for (const delta of [80, 60, 40, 20, 10]) {
      await page.evaluate((delta) => {
        const trace = (window as any).__anchorGestureTrace
        trace.requestedPrefixes.push(trace.requestedPrefixes.at(-1) + delta)
      }, delta)
      await page.mouse.wheel(0, -delta)
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    }
    await scroll.evaluate(async (root, height) => {
      for (let frame = 0; frame < 600 && root.scrollHeight <= height; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
      if (root.scrollHeight <= height) throw new Error('History page did not land')
    }, before.height)
    await settle()
    const trace = await page.evaluate(() => {
      const trace = (window as unknown as { __anchorGestureTrace: { finish: () => void; baseline: number; frames: { content: number | null; prefixes: number[] }[]; prefixes: number[]; requestedPrefixes: number[] } }).__anchorGestureTrace
      trace.finish()
      const maxResidual = Math.max(0, ...trace.frames.map((frame) => frame.content === null ? Infinity : Math.min(...frame.prefixes.map((prefix) => Math.abs(frame.content! - trace.baseline - prefix)))))
      const last = trace.frames.at(-1)
      const finalResidual = last?.content == null ? Infinity : Math.abs(last.content - trace.baseline - trace.requestedPrefixes.at(-1)!)
      return { ...trace, finish: undefined, maxResidual, finalResidual }
    })
    results.push({ landing, before, approach, ...trace })
  }
  return results
}
