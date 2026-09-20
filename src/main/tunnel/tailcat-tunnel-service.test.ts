import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '../../shared/child-process/run-process'
import { probeTailcatBinary, type TailcatCompatibility } from './tailcat-compatibility'
import type { TailcatProcessSpawner } from './tailcat-socks-proxy'
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
      tunnel.dial(
        { v: 1, kind: 'tailcat', token: 'tcTOKEN', port: 6768 },
        new AbortController().signal
      )
    ).rejects.toThrow('too old')
    await tunnel.stop()
  })

  it('cancels and drains a shared probe before ensureServer or dial can spawn children', async () => {
    class ProbeChild extends EventEmitter {
      readonly stdout = new PassThrough()
      readonly stderr = new PassThrough()
      readonly stdin = new PassThrough()
      exitCode: number | null = null
      signalCode: NodeJS.Signals | null = null

      kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
        setTimeout(() => {
          this.signalCode = signal
          this.emit('exit', null, signal)
        }, 10)
        return true
      }
    }

    const children: ProbeChild[] = []
    const spawn: TailcatProcessSpawner = () => {
      const child = new ProbeChild()
      children.push(child)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fake implements the child lifecycle and streams consumed by the probe.
      return child as unknown as ReturnType<TailcatProcessSpawner>
    }
    const run = vi.fn(async (spec: ProcessSpec) => {
      const args = [...(spec.args ?? [])]
      const key = args.find((argument) => argument.startsWith('--key='))
      if (args[0] === 'genkey' && key) {
        writeFileSync(key.slice('--key='.length), '{}')
      }
      const stdout =
        args[0] === 'version'
          ? 'v0.4.0\n'
          : args[0] === 'parse'
            ? '{"ServerPublic":"nodekey:abc"}\n'
            : args.includes('--client')
              ? 'nodekey:abc\n'
              : 'tcPROBETOKEN\n'
      return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
    })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-tailcat-service-stop-'))
    const probeDirectory = mkdtempSync(join(tmpdir(), 'orca-tailcat-service-probe-'))
    const tunnel = new TailcatTunnelService({
      userDataPath,
      resolveBinary: () => '/opt/tailcat',
      probe: (binary, signal) =>
        probeTailcatBinary(binary, { run, spawn, signal, probeDirectory, timeoutMs: 2_000 })
    })
    const externalAbort = new AbortController()
    const server = tunnel.ensureServer(6768)
    const dial = tunnel.dial(
      { v: 1, kind: 'tailcat', token: 'tcTOKEN', port: 6768 },
      externalAbort.signal
    )
    await vi.waitFor(() => expect(children).toHaveLength(1))

    await tunnel.stop()

    expect(children[0]!.signalCode).toBe('SIGTERM')
    await expect(server).rejects.toThrow()
    await expect(dial).rejects.toThrow()
    expect(existsSync(join(userDataPath, 'tailcat'))).toBe(false)
    await expect(tunnel.ensureServer(6768)).rejects.toThrow(/has been stopped/)
    await expect(
      tunnel.dial({ v: 1, kind: 'tailcat', token: 'tcTOKEN', port: 6768 }, externalAbort.signal)
    ).rejects.toThrow(/has been stopped/)
    expect(children).toHaveLength(1)
  })
})
