import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getAppMetrics } = vi.hoisted(() => ({ getAppMetrics: vi.fn() }))
vi.mock('electron', () => ({ app: { getAppMetrics } }))

import type { BrowserWindow } from 'electron'
import { clearCrashBreadcrumbsForTest, getCrashBreadcrumbSnapshot } from './crash-breadcrumb-store'
import {
  installRendererUnresponsiveBreadcrumb,
  RENDERER_PROBE_INTERVAL_MS,
  scrubJsCallStack
} from './renderer-unresponsive-breadcrumb'

// Shape of what Chromium returns for a packaged Windows renderer stuck in a loop.
const LOOP_STACK = [
  '',
  '    at Array.push (<anonymous>)',
  '    at runawayLoop (file:///C:/Users/alice/AppData/Local/Programs/Orca/resources/app.asar/out/renderer/assets/index-B3x.js:12:345)',
  '    at file:///C:/Users/alice/AppData/Local/Programs/Orca/resources/app.asar/out/renderer/assets/index-B3x.js:9:8'
].join('\n')

type Deferred = { resolve: () => void; reject: (error: Error) => void }

function fakeRendererWindow() {
  const probes: Deferred[] = []
  let pid = 4242
  const webContents = {
    id: 12,
    isDestroyed: () => false,
    isCrashed: vi.fn(() => false),
    isLoadingMainFrame: vi.fn(() => false),
    isDevToolsOpened: vi.fn(() => false),
    getOSProcessId: () => pid,
    executeJavaScript: vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          probes.push({ resolve, reject })
        })
    ),
    mainFrame: { collectJavaScriptCallStack: vi.fn(async () => LOOP_STACK) }
  }
  const window = Object.assign(new EventEmitter(), { webContents, isDestroyed: () => false })
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the watchdog only touches the members stubbed above.
    window: window as unknown as BrowserWindow,
    webContents,
    probes,
    setPid: (next: number) => {
      pid = next
    }
  }
}

function crumbs(name: string) {
  return getCrashBreadcrumbSnapshot().filter((crumb) => crumb.name === name)
}

async function advanceTicks(count: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(RENDERER_PROBE_INTERVAL_MS * count)
}

describe('installRendererUnresponsiveBreadcrumb', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearCrashBreadcrumbsForTest()
    getAppMetrics.mockReturnValue([
      { pid: 4242, type: 'Tab', memory: { workingSetSize: 4_000_000, privateBytes: 4_200_000 } },
      { pid: 7, type: 'Tab', memory: { workingSetSize: 1_200_000, privateBytes: 1_200_000 } }
    ])
  })

  afterEach(() => {
    vi.useRealTimers()
    clearCrashBreadcrumbsForTest()
  })

  it('records the looping JS stack and hung-renderer memory when an idle renderer stops answering', async () => {
    const { window, webContents } = fakeRendererWindow()
    const watchdog = installRendererUnresponsiveBreadcrumb(window)

    // No 'unresponsive' event: the field hang happened with no user input.
    await advanceTicks(3)

    const [onset] = crumbs('renderer_unresponsive')
    expect(onset?.data).toMatchObject({
      rendererUnresponsiveTrigger: 'probe',
      processMetricsRendererWorkingSetMB: 3906
    })
    expect(onset?.data?.jsStack).toContain('at runawayLoop (index-B3x.js:12:345)')
    expect(JSON.stringify(onset)).not.toContain('alice')
    expect(webContents.mainFrame.collectJavaScriptCallStack).toHaveBeenCalledTimes(1)
    watchdog.dispose()
  })

  it("scopes hang crumbs to the hung renderer so other renderers' reports never carry them", async () => {
    const { window, probes } = fakeRendererWindow()
    const watchdog = installRendererUnresponsiveBreadcrumb(window)
    await advanceTicks(3)
    probes[0]?.resolve()
    await vi.advanceTimersByTimeAsync(0)

    const names = (origin: string) => getCrashBreadcrumbSnapshot(origin).map((crumb) => crumb.name)
    expect(names('renderer:12')).toEqual(['renderer_unresponsive', 'renderer_responsive'])
    expect(names('renderer:99')).toEqual([])
    watchdog.dispose()
  })

  it.each([
    ['crashed', 'isCrashed'],
    ['reloading', 'isLoadingMainFrame'],
    ['paused in DevTools', 'isDevToolsOpened']
  ] as const)('does not report a renderer that is %s', async (_label, getter) => {
    const { window, webContents } = fakeRendererWindow()
    webContents[getter].mockReturnValue(true)
    const watchdog = installRendererUnresponsiveBreadcrumb(window)
    await advanceTicks(10)
    expect(crumbs('renderer_unresponsive')).toHaveLength(0)
    expect(webContents.executeJavaScript).not.toHaveBeenCalled()
    watchdog.dispose()
  })

  it('drops an open hang when the renderer starts reloading', async () => {
    const { window, webContents } = fakeRendererWindow()
    const watchdog = installRendererUnresponsiveBreadcrumb(window)
    await advanceTicks(3)
    expect(crumbs('renderer_unresponsive')).toHaveLength(1)

    webContents.isLoadingMainFrame.mockReturnValue(true)
    await advanceTicks(12)
    expect(crumbs('renderer_unresponsive_sample')).toHaveLength(0)
    watchdog.dispose()
  })

  it('resamples a lasting hang with bounded crumbs and closes it when the renderer answers', async () => {
    const { window, probes } = fakeRendererWindow()
    const watchdog = installRendererUnresponsiveBreadcrumb(window)

    await advanceTicks(3 + 6 * 20)
    const samples = crumbs('renderer_unresponsive_sample')
    expect(samples).toHaveLength(7)
    expect(samples[0]?.data).toMatchObject({ jsStackUnchanged: true })

    probes[0]?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(crumbs('renderer_responsive')[0]?.data).toMatchObject({
      rendererUnresponsiveSampleCount: 8
    })
    watchdog.dispose()
  })

  it('does not report a renderer that keeps answering', async () => {
    const { window, probes } = fakeRendererWindow()
    const watchdog = installRendererUnresponsiveBreadcrumb(window)
    for (let tick = 0; tick < 10; tick += 1) {
      await advanceTicks(1)
      probes.at(-1)?.resolve()
    }
    expect(crumbs('renderer_unresponsive')).toHaveLength(0)
    watchdog.dispose()
  })

  it('starts over when the renderer is replaced by a reload in place', async () => {
    const { window, setPid } = fakeRendererWindow()
    const watchdog = installRendererUnresponsiveBreadcrumb(window)
    await advanceTicks(2)
    setPid(5151)
    await advanceTicks(1)
    expect(crumbs('renderer_unresponsive')).toHaveLength(0)
    watchdog.dispose()
  })

  it('captures immediately on Chromium unresponsive, once per hang', async () => {
    const { window } = fakeRendererWindow()
    const watchdog = installRendererUnresponsiveBreadcrumb(window)
    window.emit('unresponsive')
    window.emit('unresponsive')
    await vi.advanceTimersByTimeAsync(0)
    expect(crumbs('renderer_unresponsive')).toHaveLength(1)
    expect(crumbs('renderer_unresponsive')[0]?.data).toMatchObject({
      rendererUnresponsiveTrigger: 'unresponsive'
    })
    watchdog.dispose()
  })

  it('records a timeout instead of waiting forever when no JS is running', async () => {
    const { window, webContents } = fakeRendererWindow()
    webContents.mainFrame.collectJavaScriptCallStack.mockReturnValue(new Promise(() => {}))
    const watchdog = installRendererUnresponsiveBreadcrumb(window)
    await advanceTicks(4)
    expect(crumbs('renderer_unresponsive')[0]?.data).toMatchObject({
      jsStackUnavailable: 'timeout'
    })
    watchdog.dispose()
  })
})

describe('scrubJsCallStack', () => {
  it('keeps only the bundle file of file:// frames', () => {
    expect(scrubJsCallStack('at f (file:///Users/bob/Orca.app/out/renderer/a.js:1:2)')).toBe(
      'at f (a.js:1:2)'
    )
  })

  it('drops install-path segments that contain parentheses', () => {
    const scrubbed = scrubJsCallStack(
      'at f (file:///C:/Users/Bob%20(Work)/AppData/Orca/out/renderer/a.js:1:2)\n    at file:///C:/Users/Bob%20(Work)/b.js:3:4'
    )
    expect(scrubbed).toBe('at f (a.js:1:2)\n    at b.js:3:4')
  })
})
