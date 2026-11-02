import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  buildRemoteWebClientUrl,
  CloudflareTunnelManager,
  type CloudflareTunnelState
} from './cloudflare-tunnel-manager'

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly kill = vi.fn((signal?: NodeJS.Signals) => {
    if (signal === 'SIGKILL') {
      queueMicrotask(() => this.emit('exit', null, 'SIGKILL'))
    }
    return true
  })
}

function connectedBanner(url: string): string {
  return [
    '2026-10-28 INF +--------------------------------------------------------------------------------------------+',
    '2026-10-28 INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
    `2026-10-28 INF |  ${url}                                                |`,
    '2026-10-28 INF +--------------------------------------------------------------------------------------------+'
  ].join('\n')
}

describe('CloudflareTunnelManager', () => {
  it('extracts the trycloudflare URL and reports connected state', async () => {
    const child = new FakeChild()
    const spawnProcess = vi.fn(() => child)
    const states: CloudflareTunnelState[] = []
    const manager = new CloudflareTunnelManager({
      spawnProcess: spawnProcess as never,
      onStateChange: (state) => states.push(state),
      now: () => 1_730_100_000_000
    })

    const started = manager.start({ localPort: 6768 })
    expect(spawnProcess).toHaveBeenCalledWith(
      'cloudflared',
      ['tunnel', '--url', 'http://127.0.0.1:6768', '--no-autoupdate'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    )
    expect(manager.getState().status).toBe('starting')

    child.stderr.emit('data', connectedBanner('https://orca-demo-tunnel.trycloudflare.com'))
    await expect(started).resolves.toEqual({
      ok: true,
      publicUrl: 'https://orca-demo-tunnel.trycloudflare.com'
    })
    expect(manager.getState()).toEqual({
      status: 'connected',
      publicUrl: 'https://orca-demo-tunnel.trycloudflare.com',
      error: null,
      startedAt: 1_730_100_000_000
    })
    expect(states.map((state) => state.status)).toEqual(['starting', 'connected'])
    await manager.stop()
  })

  it('finds a URL split across stderr chunks', async () => {
    const child = new FakeChild()
    const manager = new CloudflareTunnelManager({ spawnProcess: (() => child) as never })

    const started = manager.start({ localPort: 6768 })
    child.stderr.emit('data', 'INF |  https://orca-demo-tun')
    child.stderr.emit('data', 'nel.trycloudflare.com  |\n')

    await expect(started).resolves.toMatchObject({
      ok: true,
      publicUrl: 'https://orca-demo-tunnel.trycloudflare.com'
    })
    await manager.stop()
  })

  it('maps ENOENT to actionable cloudflared_not_found', async () => {
    const child = new FakeChild()
    const manager = new CloudflareTunnelManager({ spawnProcess: (() => child) as never })

    const started = manager.start({ localPort: 6768 })
    const error = Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' })
    child.emit('error', error)

    await expect(started).resolves.toMatchObject({
      ok: false,
      reason: 'cloudflared_not_found'
    })
    expect(manager.getState()).toMatchObject({ status: 'error', publicUrl: null })
  })

  it('times out when cloudflared never publishes a public URL', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const manager = new CloudflareTunnelManager({
        spawnProcess: (() => child) as never,
        startupTimeoutMs: 50
      })

      const started = manager.start({ localPort: 6768 })
      await vi.advanceTimersByTimeAsync(50)
      await expect(started).resolves.toMatchObject({ ok: false, reason: 'timeout' })
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops with SIGTERM and returns to idle', async () => {
    const child = new FakeChild()
    child.kill.mockImplementation((signal?: NodeJS.Signals) => {
      queueMicrotask(() => child.emit('exit', null, signal ?? 'SIGTERM'))
      return true
    })
    const manager = new CloudflareTunnelManager({ spawnProcess: (() => child) as never })

    const started = manager.start({ localPort: 6768 })
    child.stderr.emit('data', connectedBanner('https://orca-demo-tunnel.trycloudflare.com'))
    await started

    await expect(manager.stop()).resolves.toEqual({
      status: 'idle',
      publicUrl: null,
      error: null,
      startedAt: null
    })
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('reuses an already connected tunnel on the same port', async () => {
    const child = new FakeChild()
    const spawnProcess = vi.fn(() => child)
    const manager = new CloudflareTunnelManager({ spawnProcess: spawnProcess as never })

    const started = manager.start({ localPort: 6768 })
    child.stderr.emit('data', connectedBanner('https://orca-demo-tunnel.trycloudflare.com'))
    await started

    await expect(manager.start({ localPort: 6768 })).resolves.toEqual({
      ok: true,
      publicUrl: 'https://orca-demo-tunnel.trycloudflare.com'
    })
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    await manager.stop()
  })

  it('puts the pairing payload in the URL fragment of the mobile route', () => {
    expect(
      buildRemoteWebClientUrl('https://orca-demo-tunnel.trycloudflare.com', 'orca-offer&with=chars')
    ).toBe(
      'https://orca-demo-tunnel.trycloudflare.com/remote#pairing=orca-offer%26with%3Dchars'
    )
  })
})
