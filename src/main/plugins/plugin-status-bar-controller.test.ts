import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import type { PluginStatusBarItemState } from '../../shared/plugins/plugin-status-bar'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { PluginStatusBarController } from './plugin-status-bar-controller'

function plugin(
  key: string,
  statusBarItems: Record<string, unknown>[],
  name = key
): ValidDiscoveredPlugin {
  const [publisher, id] = key.split('.')
  return {
    pluginKey: key,
    rootDir: `/plugins/${key}`,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id,
      publisher,
      name,
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      main: 'main.mjs',
      contributes: {
        panels: [{ id: 'live', title: 'Live', entry: 'panel.html' }],
        commands: [{ id: 'reset', title: 'Reset' }],
        statusBarItems
      },
      capabilities: [{ kind: 'statusBar' }]
    }),
    consentFingerprint: 'sha256-consented',
    contentHash: null,
    isDev: true
  }
}

const text = (value: string): PluginStatusBarItemState => ({
  text: value,
  severity: 'normal',
  visible: true
})

function createController(plugins: ValidDiscoveredPlugin[]) {
  const approved = new Map(plugins.map((entry) => [entry.pluginKey, entry]))
  const ensureWorker = vi.fn().mockResolvedValue(undefined)
  const log = vi.fn()
  const controller = new PluginStatusBarController({
    resolveApprovedPlugin: (key) => approved.get(key) ?? null,
    ensureWorker,
    log: () => log
  })
  const published: unknown[][] = []
  controller.onChanged((items) => published.push(items))
  return { controller, approved, ensureWorker, log, published }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PluginStatusBarController', () => {
  it('coalesces bursts to at most one publish per 250 ms with the latest state', async () => {
    const { controller, published } = createController([
      plugin('orca-samples.live', [{ id: 'pulse' }])
    ])

    for (let index = 0; index < 100; index += 1) {
      controller.update('orca-samples.live', 'pulse', text(`Pulse ${index}`))
      await vi.advanceTimersByTimeAsync(10)
    }
    await vi.advanceTimersByTimeAsync(250)

    // 100 updates over ~1 s reach the renderer at <= 4/s, ending on the last state.
    expect(published.length).toBeLessThanOrEqual(6)
    expect(published.at(-1)).toMatchObject([{ itemId: 'pulse', text: 'Pulse 99' }])
  })

  it('does not republish an unchanged state', async () => {
    const { controller, published } = createController([
      plugin('orca-samples.live', [{ id: 'pulse' }])
    ])
    controller.update('orca-samples.live', 'pulse', text('same'))
    await vi.advanceTimersByTimeAsync(300)
    controller.update('orca-samples.live', 'pulse', text('same'))
    await vi.advanceTimersByTimeAsync(300)
    expect(published).toHaveLength(1)
  })

  it('accepts updates only for declared items of an approved plugin', () => {
    const { controller, approved } = createController([
      plugin('orca-samples.live', [{ id: 'pulse' }])
    ])
    expect(controller.update('orca-samples.live', 'other', text('x'))).toEqual({
      ok: false,
      error: 'unknown status bar item: other'
    })
    expect(controller.update('orca-samples.other', 'pulse', text('x'))).toEqual({
      ok: false,
      error: 'plugin is not enabled'
    })
    approved.clear()
    expect(controller.update('orca-samples.live', 'pulse', text('x'))).toMatchObject({ ok: false })
  })

  it('projects visible items in render order with manifest defaults', () => {
    const { controller } = createController([
      plugin('orca-samples.alpha', [
        { id: 'low', priority: -1 },
        { id: 'open', alignment: 'left', panel: 'live' },
        { id: 'hidden' },
        { id: 'blank' }
      ]),
      plugin('orca-samples.beta', [{ id: 'high', priority: 5, command: 'reset' }], 'Beta')
    ])
    controller.update('orca-samples.alpha', 'low', { ...text('Low'), tooltip: 'Low tip' })
    controller.update('orca-samples.alpha', 'open', text('Open'))
    controller.update('orca-samples.alpha', 'hidden', { ...text('Hidden'), visible: false })
    controller.update('orca-samples.alpha', 'blank', text('  '))
    controller.update('orca-samples.beta', 'high', { ...text('High'), severity: 'error' })

    expect(controller.snapshot()).toEqual([
      {
        pluginKey: 'orca-samples.beta',
        pluginName: 'Beta',
        itemId: 'high',
        alignment: 'right',
        priority: 5,
        command: 'reset',
        text: 'High',
        severity: 'error'
      },
      {
        pluginKey: 'orca-samples.alpha',
        pluginName: 'orca-samples.alpha',
        itemId: 'open',
        alignment: 'left',
        priority: 0,
        panelTabKey: 'plugin:orca-samples.alpha/live',
        text: 'Open',
        severity: 'normal'
      },
      {
        pluginKey: 'orca-samples.alpha',
        pluginName: 'orca-samples.alpha',
        itemId: 'low',
        alignment: 'right',
        priority: -1,
        text: 'Low',
        tooltip: 'Low tip',
        severity: 'normal'
      }
    ])
    expect(controller.hasVisibleItems('orca-samples.alpha')).toBe(true)
  })

  it('drops a plugin from snapshots once it is no longer approved or its worker is gone', async () => {
    const { controller, approved, published } = createController([
      plugin('orca-samples.live', [{ id: 'pulse' }]),
      plugin('orca-samples.other', [{ id: 'pulse' }])
    ])
    controller.update('orca-samples.live', 'pulse', text('Live'))
    controller.update('orca-samples.other', 'pulse', text('Other'))
    approved.delete('orca-samples.other')
    expect(controller.snapshot().map((item) => item.pluginKey)).toEqual(['orca-samples.live'])

    controller.clearPlugin('orca-samples.live')
    await vi.advanceTimersByTimeAsync(300)
    expect(controller.hasVisibleItems('orca-samples.live')).toBe(false)
    expect(published.at(-1)).toEqual([])
  })

  it('starts each approved status-bar worker once per revision when a surface lists', () => {
    const live = plugin('orca-samples.live', [{ id: 'pulse' }])
    const noItems = plugin('orca-samples.quiet', [])
    const { controller, approved, ensureWorker } = createController([live, noItems])

    controller.listForSurface([live, noItems])
    controller.listForSurface([live, noItems])
    expect(ensureWorker).toHaveBeenCalledTimes(1)
    expect(ensureWorker).toHaveBeenCalledWith(live)

    // Disabling forgets the activation so re-enabling starts the worker again.
    approved.delete(live.pluginKey)
    controller.listForSurface([live])
    approved.set(live.pluginKey, live)
    controller.listForSurface([live])
    expect(ensureWorker).toHaveBeenCalledTimes(2)

    const revised = plugin('orca-samples.live', [{ id: 'pulse' }, { id: 'second' }])
    approved.set(revised.pluginKey, revised)
    controller.listForSurface([revised])
    expect(ensureWorker).toHaveBeenCalledTimes(3)
  })

  it('logs instead of throwing when activation fails', async () => {
    const live = plugin('orca-samples.live', [{ id: 'pulse' }])
    const { controller, ensureWorker, log } = createController([live])
    ensureWorker.mockRejectedValueOnce(new Error('boom'))
    controller.listForSurface([live])
    await vi.advanceTimersByTimeAsync(0)
    expect(log).toHaveBeenCalledWith('status bar activation failed: boom')
  })
})
