import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PANEL_MESSAGE_MAX_BYTES,
  PANEL_WORKER_REPLY_MAX_BYTES
} from '../../../shared/plugins/frames/plugin-frame-bridge'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import type { PluginHostCallOutcome } from '../../../shared/plugins/frames/plugin-protocol'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import type { PluginWorkerHandle } from '../workers/plugin-host-process'
import { deliverPluginPanelMessage } from './plugin-panel-worker-messages'

afterEach(() => {
  vi.useRealTimers()
})

function plugin(options: { main?: string } = {}): ValidDiscoveredPlugin {
  return {
    pluginKey: 'samples.demo',
    rootDir: '/plugin',
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'demo',
      publisher: 'samples',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      ...(options.main ? { main: options.main } : {}),
      contributes: {
        panels: [{ id: 'player', title: 'Player', entry: 'panel.html' }],
        commands: [],
        events: []
      },
      capabilities: []
    }),
    consentFingerprint: 'sha256-consented',
    contentHash: null,
    isDev: true
  }
}

function setup(reply: PluginHostCallOutcome = { ok: true, value: null }) {
  const deliverPanelMessage = vi.fn(async () => reply)
  const handle = { deliverPanelMessage } as unknown as PluginWorkerHandle
  const ensureWorker = vi.fn(async () => handle)
  const log = vi.fn()
  const deliver = (message: unknown, target = plugin({ main: 'worker.mjs' })) =>
    deliverPluginPanelMessage({ plugin: target, panelId: 'player', message, ensureWorker, log })
  return { deliver, deliverPanelMessage, ensureWorker, log }
}

describe('deliverPluginPanelMessage', () => {
  it('delivers the message to the plugin worker under the bound panel id', async () => {
    const { deliver, deliverPanelMessage } = setup({ ok: true, value: { playing: true } })

    await expect(deliver({ type: 'getState' })).resolves.toEqual({
      ok: true,
      value: { playing: true }
    })
    expect(deliverPanelMessage).toHaveBeenCalledWith('player', { type: 'getState' })
  })

  it('treats forged identity in the message as plain data for the bound worker', async () => {
    const { deliver, deliverPanelMessage } = setup()
    const forged = { pluginKey: 'samples.other', panelId: 'admin', type: 'x' }

    await deliver(forged)

    expect(deliverPanelMessage).toHaveBeenCalledWith('player', forged)
  })

  it('answers unknown_method without starting anything when the plugin has no worker', async () => {
    const { deliver, ensureWorker } = setup()

    await expect(deliver({}, plugin())).resolves.toMatchObject({
      ok: false,
      code: 'unknown_method'
    })
    expect(ensureWorker).not.toHaveBeenCalled()
  })

  it('refuses a message that is not JSON before touching the worker', async () => {
    const { deliver, ensureWorker } = setup()
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle

    for (const message of [undefined, 1n, cycle]) {
      await expect(deliver(message)).resolves.toMatchObject({ ok: false, code: 'invalid_params' })
    }
    expect(ensureWorker).not.toHaveBeenCalled()
  })

  it('refuses a message over the panel size limit, measured as JSON', async () => {
    const { deliver, ensureWorker } = setup()
    const numbers = Array.from({ length: 4000 }, () => 0.1234567890123456)

    await expect(deliver('x'.repeat(PANEL_MESSAGE_MAX_BYTES + 1))).resolves.toMatchObject({
      ok: false,
      code: 'too_large'
    })
    // Small by the admission estimate (8 bytes a number) but about 90 KB once written as JSON.
    await expect(deliver(numbers)).resolves.toMatchObject({ ok: false, code: 'too_large' })
    expect(ensureWorker).not.toHaveBeenCalled()
  })

  it('answers unavailable when the worker cannot start, and does not wait on a full slot pool forever', async () => {
    vi.useFakeTimers()
    const { deliver, ensureWorker } = setup()
    ensureWorker.mockRejectedValueOnce(new Error('plugin samples.demo is errored'))

    await expect(deliver({})).resolves.toMatchObject({ ok: false, code: 'unavailable' })

    ensureWorker.mockReturnValueOnce(new Promise(() => undefined))
    const waiting = deliver({})
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(waiting).resolves.toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('passes through the worker failure outcome', async () => {
    const failure = { ok: false, code: 'action_failed', error: 'no active device' } as const
    const { deliver } = setup(failure)

    await expect(deliver({})).resolves.toEqual(failure)
  })

  it('normalizes a reply to plain JSON', async () => {
    const { deliver } = setup({ ok: true, value: { at: new Date(0), skipped: undefined } })

    await expect(deliver({})).resolves.toEqual({
      ok: true,
      value: { at: '1970-01-01T00:00:00.000Z' }
    })
  })

  it('carries a reply large enough for a small cover image but not past the reply limit', async () => {
    const cover = `data:image/jpeg;base64,${'A'.repeat(80 * 1024)}`
    const carried = setup({ ok: true, value: { cover } })
    await expect(carried.deliver({})).resolves.toEqual({ ok: true, value: { cover } })

    const oversized = setup({ ok: true, value: 'x'.repeat(PANEL_WORKER_REPLY_MAX_BYTES + 1) })
    await expect(oversized.deliver({})).resolves.toMatchObject({ ok: false, code: 'too_large' })
    expect(oversized.log).toHaveBeenCalledWith('panel player reply dropped: too_large')
  })

  it('refuses a reply that is not JSON', async () => {
    const { deliver } = setup({ ok: true, value: 1n })

    await expect(deliver({})).resolves.toMatchObject({ ok: false, code: 'action_failed' })
  })
})
