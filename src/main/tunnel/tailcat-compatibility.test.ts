import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '../../shared/child-process/run-process'
import { probeTailcatBinary, TAILCAT_INCOMPATIBLE_HINT } from './tailcat-compatibility'
import type { TailcatProcessSpawner } from './tailcat-socks-proxy'

type FakeResult = { code: number; stdout?: string; stderr?: string }

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode === null && this.signalCode === null) {
      this.signalCode = signal
      this.emit('exit', null, signal)
    }
    return true
  }
}

/** Scripts a tailcat 0.4 that writes the key files it is asked for, so the probe's file checks pass. */
function fakeTailcat(overrides: Partial<Record<string, FakeResult>> = {}) {
  const calls: string[][] = []
  const run = vi.fn(async (spec: ProcessSpec) => {
    const args = [...(spec.args ?? [])]
    calls.push(args)
    const subcommand =
      args[0] === 'genkey' ? (args.includes('--client') ? 'genkey-client' : 'genkey') : args[0]!
    const keyArgument = args.find((argument) => argument.startsWith('--key='))
    if (subcommand.startsWith('genkey') && keyArgument && !(subcommand in overrides)) {
      writeFileSync(keyArgument.slice('--key='.length), '{}')
    }
    const result = overrides[subcommand] ??
      defaults[subcommand] ?? { code: 1, stderr: `unknown ${subcommand}` }
    return {
      code: result.code,
      signal: null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: false
    }
  })
  const children: FakeChild[] = []
  const spawn: TailcatProcessSpawner = (spec) => {
    calls.push([...(spec.args ?? [])])
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ReturnType<TailcatProcessSpawner>
  }
  return { run, spawn, calls, children }
}

const defaults: Record<string, FakeResult> = {
  version: { code: 0, stdout: 'v0.4.0\n' },
  genkey: { code: 0, stdout: 'tcPROBETOKEN\n' },
  'genkey-client': { code: 0, stdout: 'nodekey:abc\n' },
  parse: { code: 0, stdout: '{\n  "ServerPublic": "nodekey:abc",\n  "RegionID": 302\n}\n' }
}

function probeDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'orca-tailcat-probe-test-'))
}

describe('probeTailcatBinary', () => {
  it('passes a tailcat that generates keys, parses its token, and reports a SOCKS listener', async () => {
    const tailcat = fakeTailcat()
    const directory = probeDirectory()
    const pending = probeTailcatBinary('/usr/bin/tailcat', {
      run: tailcat.run,
      spawn: tailcat.spawn,
      probeDirectory: directory,
      timeoutMs: 2_000
    })
    await vi.waitFor(() => expect(tailcat.children).toHaveLength(1))
    tailcat.children[0]!.stderr.write('SOCKS running at socks5h://127.0.0.1:41000\n')
    await expect(pending).resolves.toEqual({ ok: true, version: 'v0.4.0' })
    expect(tailcat.calls.map((call) => call[0])).toEqual([
      'version',
      'genkey',
      'parse',
      'genkey',
      expect.stringMatching(/^--key=/)
    ])
    expect(tailcat.calls[1]).toContain('--region=302')
    expect(tailcat.calls[2]).toEqual(['parse', 'tcPROBETOKEN'])
    expect(tailcat.calls[4]).toEqual([
      expect.stringMatching(/^--key=.*probe-client\.private\.json$/),
      'socks',
      '--listen=127.0.0.1:0'
    ])
    expect(existsSync(join(directory, 'probe-server.private.json'))).toBe(true)
  })

  it('fails a build whose subcommands are unknown, keeping the version as advisory context', async () => {
    // Why: tailcat 0.3 has no `genkey` subcommand; it treats the word as a server address.
    const tailcat = fakeTailcat({
      version: { code: 0, stdout: 'v0.3.0\n' },
      genkey: {
        code: 1,
        stderr: 'argument "genkey" is neither a "tc"-prefixed address blob nor a DNS name'
      }
    })
    const result = await probeTailcatBinary('/usr/bin/tailcat', {
      run: tailcat.run,
      spawn: tailcat.spawn,
      probeDirectory: probeDirectory(),
      timeoutMs: 2_000
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.version).toBe('v0.3.0')
      expect(result.reason).toMatch(/genkey did not produce a server key/)
      expect(result.reason).toContain(TAILCAT_INCOMPATIBLE_HINT)
    }
    expect(tailcat.children).toHaveLength(0)
  })

  it('fails when the SOCKS proxy exits instead of announcing a listener', async () => {
    const tailcat = fakeTailcat()
    const pending = probeTailcatBinary('/usr/bin/tailcat', {
      run: tailcat.run,
      spawn: tailcat.spawn,
      probeDirectory: probeDirectory(),
      timeoutMs: 2_000
    })
    await vi.waitFor(() => expect(tailcat.children).toHaveLength(1))
    tailcat.children[0]!.stderr.write('flag provided but not defined: -listen\n')
    tailcat.children[0]!.exitCode = 2
    tailcat.children[0]!.emit('exit', 2, null)
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/tailcat socks exited \(2\)/)
      expect(result.reason).toContain('flag provided but not defined')
    }
  })

  it('tolerates a missing version subcommand', async () => {
    const tailcat = fakeTailcat({ version: { code: 1, stderr: 'unknown' } })
    const pending = probeTailcatBinary('/usr/bin/tailcat', {
      run: tailcat.run,
      spawn: tailcat.spawn,
      probeDirectory: probeDirectory(),
      timeoutMs: 2_000
    })
    await vi.waitFor(() => expect(tailcat.children).toHaveLength(1))
    tailcat.children[0]!.stderr.write('SOCKS running at socks5h://127.0.0.1:41001\n')
    await expect(pending).resolves.toEqual({ ok: true, version: null })
  })
})
