import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LAUNCH_TOKEN_ECHO_PROTOCOL_VERSION } from '../../shared/agent-launch-token-echo-protocol'
import { SshPtyProvider } from './ssh-pty-provider'

describe('SSH launch-token echo negotiation', () => {
  const request = vi.fn()
  let provider: SshPtyProvider

  beforeEach(() => {
    request.mockReset()
    provider = new SshPtyProvider('conn-1', {
      request,
      notify: vi.fn(),
      onNotification: vi.fn(),
      dispose: vi.fn(),
      isDisposed: vi.fn(() => false)
    } as never)
  })

  function spawnParams(): Record<string, unknown> {
    const call = request.mock.calls.find(([method]) => method === 'pty.spawn')
    return (call?.[1] ?? {}) as Record<string, unknown>
  }

  // New main + old relay: the relay accepts launchToken and never re-lists it, so a
  // crash-recovery re-list would read the live agent as absent and Retry would duplicate it.
  it('withholds the token from a relay that cannot echo it', async () => {
    request.mockImplementation(async (method: string) =>
      method === 'pty.getCapabilities' ? {} : { id: 'pty-old', incarnationId: 'inc-old' }
    )

    await provider.spawn({ cols: 80, rows: 24, command: 'claude', launchToken: 'tok-1' })
    await provider.spawn({ cols: 80, rows: 24, command: 'claude', launchToken: 'tok-2' })

    expect('launchToken' in spawnParams()).toBe(false)
    expect(provider.providesLaunchTokenListings()).toBe(false)
    expect(request.mock.calls.filter(([method]) => method === 'pty.getCapabilities')).toHaveLength(
      1
    )
  })

  it('sends the token once the relay advertises the echo', async () => {
    request.mockImplementation(async (method: string) =>
      method === 'pty.getCapabilities'
        ? { launchTokenEchoVersion: LAUNCH_TOKEN_ECHO_PROTOCOL_VERSION }
        : { id: 'pty-new', incarnationId: 'inc-new' }
    )

    await provider.spawn({ cols: 80, rows: 24, command: 'claude', launchToken: 'tok-2' })

    expect(spawnParams().launchToken).toBe('tok-2')
    expect(provider.providesLaunchTokenListings()).toBe(true)
  })

  // Old main + new relay: the advertisement is purely additive, so a tokenless spawn
  // (all an old main ever sends) stays byte-for-byte what it was and probes nothing.
  it('leaves a tokenless spawn unprobed and unchanged', async () => {
    request.mockResolvedValue({ id: 'pty-plain', incarnationId: 'inc-plain' })

    await provider.spawn({ cols: 80, rows: 24, command: 'claude' })

    expect(request.mock.calls.map(([method]) => method)).toEqual(['pty.spawn'])
    expect('launchToken' in spawnParams()).toBe(false)
  })

  it('caches an old-relay negative for the provider connection', async () => {
    request.mockResolvedValueOnce({}).mockResolvedValueOnce({
      launchTokenEchoVersion: LAUNCH_TOKEN_ECHO_PROTOCOL_VERSION
    })

    await expect(provider.supportsLaunchTokenEcho()).resolves.toBe(false)
    await expect(provider.supportsLaunchTokenEcho()).resolves.toBe(false)
    expect(request).toHaveBeenCalledOnce()
  })

  it('caches an old relay without the capability method', async () => {
    request.mockRejectedValue(Object.assign(new Error('Method not found'), { code: -32601 }))

    await expect(provider.supportsLaunchTokenEcho()).resolves.toBe(false)
    await expect(provider.supportsLaunchTokenEcho()).resolves.toBe(false)
    expect(request).toHaveBeenCalledOnce()
  })

  it('retries an unverifiable transport failure on the same connection', async () => {
    request.mockRejectedValueOnce(new Error('connection stalled')).mockResolvedValueOnce({
      launchTokenEchoVersion: LAUNCH_TOKEN_ECHO_PROTOCOL_VERSION
    })

    await expect(provider.supportsLaunchTokenEcho()).resolves.toBe(false)
    await expect(provider.supportsLaunchTokenEcho()).resolves.toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('re-probes capabilities on a replacement provider connection', async () => {
    request.mockResolvedValueOnce({}).mockResolvedValueOnce({
      launchTokenEchoVersion: LAUNCH_TOKEN_ECHO_PROTOCOL_VERSION
    })

    await expect(provider.supportsLaunchTokenEcho()).resolves.toBe(false)
    const replacement = new SshPtyProvider('conn-1', {
      request,
      notify: vi.fn(),
      onNotification: vi.fn(),
      dispose: vi.fn(),
      isDisposed: vi.fn(() => false)
    } as never)
    await expect(replacement.supportsLaunchTokenEcho()).resolves.toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
  })
})
