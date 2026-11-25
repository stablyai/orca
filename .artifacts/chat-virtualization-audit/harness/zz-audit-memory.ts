import type { ElectronApplication, Page } from '@stablyai/playwright-test'
export async function memory(app: ElectronApplication, page: Page) {
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

