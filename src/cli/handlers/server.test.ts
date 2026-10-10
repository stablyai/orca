import { afterEach, describe, expect, it, vi } from 'vitest'
import { SERVER_HANDLERS } from './server'
import { RuntimeClientError } from '../runtime-client'
import { parseTtlMs, resolvePairingCodeInput } from '../runtime/pairing-code-input'
import { reportCliError } from '../format'
import { addEnvironmentFromPairingCode } from '../runtime/environments'
import type * as runtimeEnvironmentsModule from '../runtime/environments'

type AddArgs = Parameters<typeof addEnvironmentFromPairingCode>[1]

vi.mock('../runtime/environments', async (importOriginal) => {
  const actual = await importOriginal<typeof runtimeEnvironmentsModule>()
  return { ...actual, addEnvironmentFromPairingCode: vi.fn() }
})

const addEnvironmentFromPairingCodeMock = vi.mocked(addEnvironmentFromPairingCode)

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal shape for the call-site narrowing vi.mocked applies.
const REDACTED_ENVIRONMENT = {
  name: 'homelab',
  id: 'env-1',
  endpoints: []
} as never

const SECRET = 'orca://pair?code=super-secret-code'

function ctx(overrides: {
  flags?: Map<string, string | boolean>
  call?: ReturnType<typeof vi.fn>
  json?: boolean
}) {
  return {
    flags: overrides.flags ?? new Map<string, string | boolean>(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handlers only invoke client.call; the rest of the client surface is unused in tests.
    client: { call: overrides.call ?? vi.fn() } as never,
    cwd: '/tmp',
    json: overrides.json ?? false
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  addEnvironmentFromPairingCodeMock.mockReset()
})

describe('server link handler', () => {
  it('calls the runtime RPC and prints the URL exactly once', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'r1',
      ok: true,
      result: {
        available: true,
        pairingUrl: 'https://pair.example/pair?code=abc',
        webClientUrl: 'https://web.example',
        endpoint: 'ws://10.0.0.2:7331',
        deviceId: 'device-1'
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await SERVER_HANDLERS['server link']!(ctx({ call }))
    expect(call).toHaveBeenCalledWith('mobile.getRuntimePairingUrl', {})
    const lines = log.mock.calls.map((args) => String(args[0]))
    expect(lines.join('\n')).toContain('https://pair.example/pair?code=abc')
    expect(lines.join('\n')).toContain('device-1')
    expect(lines.join('\n')).toContain('ws://10.0.0.2:7331')
    expect(
      lines.filter((line) => line.includes('https://pair.example/pair?code=abc'))
    ).toHaveLength(1)
  })

  it('sends parsed ttlMs when --ttl is given', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'r1',
      ok: true,
      result: {
        available: true,
        pairingUrl: 'u',
        webClientUrl: 'w',
        endpoint: 'e',
        deviceId: 'd'
      },
      _meta: { runtimeId: 'r' }
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await SERVER_HANDLERS['server link']!(
      ctx({
        call,
        flags: new Map<string, string | boolean>([
          ['ttl', '24h'],
          ['rotate', true],
          ['reach', 'network']
        ])
      })
    )
    expect(call).toHaveBeenCalledWith(
      'mobile.getRuntimePairingUrl',
      expect.objectContaining({ ttlMs: 24 * 60 * 60 * 1000, rotate: true, reach: 'network' })
    )
  })

  it('rejects remote-selection flags', async () => {
    const call = vi.fn()
    await expect(
      SERVER_HANDLERS['server link']!(
        ctx({ call, flags: new Map([['environment', 'work-laptop']]) })
      )
    ).rejects.toThrow(RuntimeClientError)
    await expect(
      SERVER_HANDLERS['server link']!(ctx({ call, flags: new Map([['pairing-code', 'x']]) }))
    ).rejects.toThrow(/--pairing-code/)
    expect(call).not.toHaveBeenCalled()
  })

  it('reports unavailable without printing any URL', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'r1',
      ok: true,
      result: {
        available: false,
        reason: 'disabled_by_operator',
        guidance: 'Enable pairing to continue.'
      },
      _meta: { runtimeId: 'r' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(SERVER_HANDLERS['server link']!(ctx({ call }))).rejects.toThrow(
      /disabled_by_operator/
    )
    await expect(SERVER_HANDLERS['server link']!(ctx({ call }))).rejects.toThrow(
      /Enable pairing to continue/
    )
    const output = [...log.mock.calls, ...err.mock.calls].map((c) => String(c[0])).join('\n')
    expect(output).not.toMatch(/https?:\/\//)
  })

  it('shapes the json result', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'r1',
      ok: true,
      result: {
        available: true,
        pairingUrl: 'https://pair.example/pair?code=abc',
        webClientUrl: 'https://web.example',
        endpoint: 'ws://10.0.0.2:7331',
        deviceId: 'device-1'
      },
      _meta: { runtimeId: 'r' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await SERVER_HANDLERS['server link']!(ctx({ call, json: true }))
    const payload = JSON.parse(log.mock.calls.map((c) => String(c[0])).join('\n'))
    expect(payload.ok).toBe(true)
    expect(payload.result).toEqual({
      schemaVersion: 1,
      pairingUrl: 'https://pair.example/pair?code=abc',
      webClientUrl: 'https://web.example',
      endpoint: 'ws://10.0.0.2:7331',
      deviceId: 'device-1'
    })
  })
})

describe('parseTtlMs', () => {
  it('parses durations and plain integers', () => {
    expect(parseTtlMs('30m')).toBe(30 * 60 * 1000)
    expect(parseTtlMs('24h')).toBe(24 * 60 * 60 * 1000)
    expect(parseTtlMs('7d')).toBe(7 * 24 * 60 * 60 * 1000)
    expect(parseTtlMs('5000')).toBe(5000)
    expect(parseTtlMs('90s')).toBe(90_000)
    expect(parseTtlMs('10ms')).toBe(10)
  })

  it('rejects invalid, non-positive, and over-cap values', () => {
    expect(() => parseTtlMs('abc')).toThrow(RuntimeClientError)
    expect(() => parseTtlMs('-5m')).toThrow(RuntimeClientError)
    expect(() => parseTtlMs('0')).toThrow(RuntimeClientError)
    expect(() => parseTtlMs('31d')).toThrow(/30d/)
    expect(() => parseTtlMs('')).toThrow(RuntimeClientError)
  })
})

describe('resolvePairingCodeInput', () => {
  it('accepts the positional slot', async () => {
    expect(await resolvePairingCodeInput({ positional: SECRET, flags: new Map() })).toBe(SECRET)
  })

  it('accepts the --pairing-code flag', async () => {
    expect(await resolvePairingCodeInput({ flags: new Map([['pairing-code', SECRET]]) })).toBe(
      SECRET
    )
  })

  it('reads --pairing-code-file', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'orca-server-add-'))
    const file = join(dir, 'code.txt')
    await writeFile(file, `  ${SECRET}\n`, 'utf8')
    expect(await resolvePairingCodeInput({ flags: new Map([['pairing-code-file', file]]) })).toBe(
      SECRET
    )
  })

  it('reads stdin via the injected reader', async () => {
    expect(
      await resolvePairingCodeInput({
        flags: new Map([['pairing-code', '-']]),
        readStdin: async () => `${SECRET}\n`
      })
    ).toBe(SECRET)
  })

  it('fails on zero and multiple sources', async () => {
    await expect(resolvePairingCodeInput({ flags: new Map() })).rejects.toThrow(
      /exactly one|Missing pairing code/
    )
    await expect(
      resolvePairingCodeInput({
        positional: SECRET,
        flags: new Map([['pairing-code', 'other']])
      })
    ).rejects.toThrow(/exactly one source/)
    await expect(
      resolvePairingCodeInput({
        flags: new Map([
          ['pairing-code', 'a'],
          ['pairing-code-file', '/tmp/x']
        ])
      })
    ).rejects.toThrow(/exactly one source/)
  })

  it('fails on empty stdin', async () => {
    await expect(
      resolvePairingCodeInput({
        flags: new Map([['pairing-code', '-']]),
        readStdin: async () => '  \n'
      })
    ).rejects.toThrow(/empty/)
  })
})

describe('server add handler', () => {
  it('adds the environment and never echoes the code', async () => {
    addEnvironmentFromPairingCodeMock.mockReturnValue(REDACTED_ENVIRONMENT)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await SERVER_HANDLERS['server add']!(
      ctx({
        flags: new Map([
          ['name', 'homelab'],
          ['pairing-code', SECRET]
        ])
      })
    )

    expect(addEnvironmentFromPairingCodeMock).toHaveBeenCalledWith(expect.any(String), {
      name: 'homelab',
      pairingCode: SECRET
    } satisfies AddArgs)
    const output = [...log.mock.calls, ...err.mock.calls].map((c) => String(c[0])).join('\n')
    expect(output).toContain('homelab')
    expect(output).not.toContain(SECRET)
    expect(output).not.toContain('super-secret-code')
  })

  it('requires --name', async () => {
    await expect(
      SERVER_HANDLERS['server add']!(ctx({ flags: new Map([['pairing-code', SECRET]]) }))
    ).rejects.toThrow(/Missing required --name/)
  })

  it('propagates invalid_argument for zero sources without echoing secrets', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await SERVER_HANDLERS['server add']!(ctx({ flags: new Map([['name', 'x']]) }))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeClientError)
      reportCliError(error, false, { commandPath: ['server', 'add'] })
    }
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(SECRET)
  })

  it('redacts a store error message that embeds the code', async () => {
    addEnvironmentFromPairingCodeMock.mockImplementation(() => {
      throw new Error(`Invalid pairing code ${SECRET} in payload`)
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(
      SERVER_HANDLERS['server add']!(
        ctx({
          flags: new Map([
            ['name', 'x'],
            ['pairing-code', SECRET]
          ])
        })
      )
    ).rejects.toThrow()
    // The handler path itself must redact; the raw error would leak.
    try {
      await SERVER_HANDLERS['server add']!(
        ctx({
          flags: new Map([
            ['name', 'x'],
            ['pairing-code', SECRET]
          ])
        })
      )
      expect.unreachable()
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-code')
      reportCliError(error, false, { commandPath: ['server', 'add'] })
    }
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('super-secret-code')
  })
})
