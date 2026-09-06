import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from '../../shared/remote-runtime-shared-control-test-server'
import { encodePairingOffer } from '../../shared/pairing'
import { addEnvironmentFromPairingCode, getEnvironmentStorePath } from '../runtime/environments'
import { listPairedEnvironmentHosts } from './paired-host-inventory'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-host-inventory-'))
})
afterEach(async () => {
  await closeSharedControlTestServers()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('paired host inventory over authenticated WebSockets', () => {
  it('reads Windows and legacy Linux servers without modifying the pairing file', async () => {
    const windows = await createSharedControlTestServer({
      results: { 'status.get': { hostPlatform: 'win32' } }
    })
    const legacy = await createSharedControlTestServer({
      results: { 'status.get': {}, 'host.platform': { platform: 'linux' } }
    })
    for (const [name, server] of [
      ['windows', windows],
      ['legacy', legacy]
    ] as const) {
      addEnvironmentFromPairingCode(userDataPath, {
        name,
        pairingCode: encodePairingOffer(server.pairing)
      })
    }
    const path = getEnvironmentStorePath(userDataPath)
    const before = readFileSync(path, 'utf8')
    const hosts = await listPairedEnvironmentHosts(userDataPath)
    expect(hosts.find((host) => host.name === 'windows')).toMatchObject({
      platform: 'win32',
      connected: true
    })
    expect(hosts.find((host) => host.name === 'legacy')).toMatchObject({
      platform: 'linux',
      connected: true
    })
    expect(windows.requests.map((request) => request.method)).toEqual(['status.get'])
    expect(legacy.requests.map((request) => request.method)).toEqual([
      'status.get',
      'host.platform'
    ])
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(JSON.stringify(hosts)).not.toContain(windows.pairing.deviceToken)
    await vi.waitFor(() =>
      expect(windows.activeConnectionCount() + legacy.activeConnectionCount()).toBe(0)
    )
  })

  it('retains unreachable rows on a mid-flight connection drop', async () => {
    const server = await createSharedControlTestServer({ closeBeforeResponse: true })
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'dropped',
      pairingCode: encodePairingOffer(server.pairing)
    })
    const [host] = await listPairedEnvironmentHosts(userDataPath)
    expect(host).toMatchObject({
      name: 'dropped',
      connectionStatus: 'unknown',
      probeError: 'probe_failed'
    })
    expect(host).not.toHaveProperty('connected')
    await vi.waitFor(() => expect(server.activeConnectionCount()).toBe(0))
  })

  it('ends a silent handshake within the scan deadline and releases its socket', async () => {
    const server = await createSharedControlTestServer({ suppressReadyFrame: true })
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'silent',
      pairingCode: encodePairingOffer(server.pairing)
    })
    const start = Date.now()
    const [host] = await listPairedEnvironmentHosts(userDataPath)
    expect(Date.now() - start).toBeLessThan(6_500)
    expect(host).toMatchObject({ probeError: 'runtime_timeout', connectionStatus: 'unknown' })
    await vi.waitFor(() => expect(server.activeConnectionCount()).toBe(0))
  }, 10_000)
})
