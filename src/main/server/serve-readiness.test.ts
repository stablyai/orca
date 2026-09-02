import { describe, expect, it, vi } from 'vitest'
import {
  renderServeReadiness,
  ServeReadinessPublisher,
  type ServeReadiness
} from './serve-readiness'
import type { OrcadHealth } from '../orcad/orcad-health'

const ready: ServeReadiness = {
  runtimeId: 'runtime-1',
  boundEndpoint: 'ws://0.0.0.0:6768',
  advertisedEndpoint: 'wss://orca.example.test/runtime',
  managedWslCliReconciliation: 'settled',
  pairing: {
    available: true,
    url: 'orca://pair?code=secret',
    endpoint: 'wss://orca.example.test/runtime',
    deviceId: 'device-1',
    webClientUrl: 'https://orca.example.test/runtime/web-index.html#pairing=secret',
    scope: 'runtime',
    qr: null
  }
}

const health: OrcadHealth = {
  buildHash: 'abc123def4567890',
  buildVersion: '1.4.0',
  nodeVersion: '20.11.0',
  nodeAbi: '115',
  platform: 'linux',
  arch: 'x64',
  pid: 1234,
  terminalDaemon: {
    state: 'live',
    ownsFreshSessions: true,
    pid: 4242,
    buildVersion: '1.4.0',
    entryPath: '/opt/orcad/daemon-entry.js',
    protocolVersion: 36,
    selfTest: { ok: true, coverage: 'pty-spawn', verdict: 'healthy', durationMs: 12 }
  }
}

describe('ServeReadinessPublisher', () => {
  it('writes one complete human-readable ready block', async () => {
    const write = vi.fn(async () => {})
    const publisher = new ServeReadinessPublisher(write)

    await publisher.publish(ready, { mode: 'human' })

    expect(write).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining(
        'Orca server ready\nBound endpoint: ws://0.0.0.0:6768\nAdvertised endpoint: wss://orca.example.test/runtime'
      )
    )
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('Pairing URL: orca://pair?code=secret\n')
    )
  })

  it('publishes a versioned JSON contract with explicit endpoints and pairing availability', () => {
    expect(JSON.parse(renderServeReadiness(ready, { mode: 'json' }))).toEqual({
      type: 'orca_server_ready',
      schemaVersion: 1,
      runtimeId: 'runtime-1',
      endpoint: 'ws://0.0.0.0:6768',
      boundEndpoint: 'ws://0.0.0.0:6768',
      advertisedEndpoint: 'wss://orca.example.test/runtime',
      managedWslCliReconciliation: 'settled',
      pairing: ready.pairing
    })
  })

  it('reports unavailable pairing as an explicit machine-readable object', () => {
    const unavailable: ServeReadiness = {
      ...ready,
      advertisedEndpoint: null,
      pairing: {
        available: false,
        reason: 'invalid_advertised_endpoint',
        guidance: 'Use a reachable address.'
      }
    }

    const json = JSON.parse(renderServeReadiness(unavailable, { mode: 'json' }))
    expect(json.pairing).toEqual(unavailable.pairing)
    expect(renderServeReadiness(unavailable, { mode: 'human' })).toContain(
      'Pairing unavailable: invalid_advertised_endpoint\nPairing guidance: Use a reachable address.'
    )
  })

  it('preserves the recipe JSON contract', () => {
    expect(renderServeReadiness(ready, { mode: 'recipe-json', projectRoot: '/workspace' })).toBe(
      '{"schemaVersion":1,"pairingCode":"orca://pair?code=secret","projectRoot":"/workspace"}'
    )
  })

  it('fails recipe output with the unavailable reason and guidance', () => {
    const unavailable: ServeReadiness = {
      ...ready,
      pairing: {
        available: false,
        reason: 'websocket_unavailable',
        guidance: 'Choose an unused --port.'
      }
    }
    expect(() =>
      renderServeReadiness(unavailable, { mode: 'recipe-json', projectRoot: '/workspace' })
    ).toThrow('websocket_unavailable. Choose an unused --port.')
  })

  it('omits the health block entirely when a host does not report one', () => {
    const payload = JSON.parse(renderServeReadiness(ready, { mode: 'json' }))
    // Why absent rather than a null/empty object: a reader must be able to tell "this host
    // does not publish health" from "this host published a green verdict".
    expect('health' in payload).toBe(false)
    expect(renderServeReadiness(ready, { mode: 'human' })).not.toContain('Terminal daemon')
  })

  it('carries build identity, Node ABI and the daemon self-test in the JSON contract', () => {
    const payload = JSON.parse(renderServeReadiness({ ...ready, health }, { mode: 'json' }))
    expect(payload.health.buildHash).toBe('abc123def4567890')
    expect(payload.health.nodeAbi).toBe('115')
    expect(payload.health.terminalDaemon.selfTest).toEqual({
      ok: true,
      coverage: 'pty-spawn',
      verdict: 'healthy',
      durationMs: 12
    })
  })

  it('says out loud when the daemon self-test failed', () => {
    const failed: ServeReadiness = {
      ...ready,
      health: {
        ...health,
        terminalDaemon: {
          ...health.terminalDaemon,
          state: 'degraded',
          ownsFreshSessions: false,
          selfTest: {
            ok: false,
            coverage: 'pty-spawn',
            verdict: 'pty-spawn-unhealthy',
            durationMs: 3_000
          }
        }
      }
    }
    const human = renderServeReadiness(failed, { mode: 'human' })
    // An operator reading the ready block must not have to infer this from a missing line.
    expect(human).toContain('PTY self-test FAILED')
    expect(human).toContain('terminals survive an orcad restart: NO')
  })

  it('rejects concurrent and later duplicate publications', async () => {
    let finishWrite: (() => void) | undefined
    const publisher = new ServeReadinessPublisher(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve
        })
    )
    const first = publisher.publish(ready, { mode: 'json' })

    await expect(publisher.publish(ready, { mode: 'json' })).rejects.toThrow(
      'publication already publishing'
    )
    finishWrite?.()
    await first
    await expect(publisher.publish(ready, { mode: 'json' })).rejects.toThrow(
      'publication already published'
    )
  })

  it('surfaces write failures and does not retry a partial contract', async () => {
    const publisher = new ServeReadinessPublisher(async () => {
      throw new Error('stdout closed')
    })

    await expect(publisher.publish(ready, { mode: 'human' })).rejects.toThrow('stdout closed')
    await expect(publisher.publish(ready, { mode: 'human' })).rejects.toThrow(
      'publication already failed'
    )
  })
})
