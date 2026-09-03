import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TailcatCompatibility } from './tailcat-compatibility'
import { TailcatTunnelService } from './tailcat-tunnel-service'

const incompatible: TailcatCompatibility = { ok: false, version: 'v0.3.0', reason: 'too old' }
const compatible: TailcatCompatibility = { ok: true, version: 'v0.4.0' }

function service(probe: (binary: string) => Promise<TailcatCompatibility>, now: () => number) {
  return new TailcatTunnelService({
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-tailcat-service-')),
    resolveBinary: () => '/opt/tailcat',
    probe,
    now
  })
}

describe('TailcatTunnelService compatibility cache', () => {
  it('re-probes a failed binary after a short delay so an upgrade is picked up', async () => {
    let clock = 1_000
    const probe = vi.fn().mockResolvedValueOnce(incompatible).mockResolvedValue(compatible)
    const tunnel = service(probe, () => clock)

    expect(await tunnel.getStatus()).toMatchObject({
      compatible: false,
      incompatibleReason: 'too old'
    })
    // Why: status polls must not spawn a probe each time, so a fresh failure is served from cache.
    expect(await tunnel.getStatus()).toMatchObject({ compatible: false })
    expect(probe).toHaveBeenCalledTimes(1)

    clock += 31_000
    expect(await tunnel.getStatus()).toMatchObject({ compatible: true, version: 'v0.4.0' })
    expect(probe).toHaveBeenCalledTimes(2)
    await tunnel.stop()
  })

  it('keeps a successful probe for the life of the service', async () => {
    let clock = 1_000
    const probe = vi.fn().mockResolvedValue(compatible)
    const tunnel = service(probe, () => clock)
    await tunnel.getStatus()
    clock += 3_600_000
    await tunnel.getStatus()
    expect(probe).toHaveBeenCalledTimes(1)
    await tunnel.stop()
  })

  it('reports the probe failure when a dial is attempted', async () => {
    const tunnel = service(vi.fn().mockResolvedValue(incompatible), () => 1)
    await expect(
      tunnel.dial({ v: 1, kind: 'tailcat', token: 'tcTOKEN', port: 6768 })
    ).rejects.toThrow('too old')
    await tunnel.stop()
  })
})
