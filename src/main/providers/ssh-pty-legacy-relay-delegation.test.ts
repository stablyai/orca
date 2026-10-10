import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshPtyHeldByPreviousRelayError } from './ssh-pty-errors'
import { SshPtyProvider } from './ssh-pty-provider'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { createMockMux, type MockMultiplexer } from './ssh-pty-provider-mock-multiplexer'
import {
  attachHeldPtyThroughPreviousRelay,
  type SshPtyLegacyRelayRouting
} from './ssh-pty-legacy-relay-delegation'
import { SshLegacyRelayRouter } from '../ssh/ssh-legacy-relay-router'

const HELD = 'ssh:target-1@@pty2:old:1'
const CURRENT = 'ssh:target-1@@pty2:new:1'

function asMux(mock: MockMultiplexer): SshChannelMultiplexer {
  mock.onNotification.mockReturnValue(() => {})
  // The provider reaches only the stubbed members on these paths.
  return Object.assign(Object.create(null), mock)
}

function currentRelayHoldsTheId(): void {
  // Before setup: the delegation captures the provider's own spawn when it is installed.
  vi.spyOn(SshPtyProvider.prototype, 'spawn').mockImplementationOnce(async () => {
    throw new SshPtyHeldByPreviousRelayError('pty2:old:1')
  })
}

function setup() {
  const currentMux = createMockMux()
  const legacyMux = createMockMux()
  const provider = new SshPtyProvider('target-1', asMux(currentMux), undefined, 7)
  const legacy = new SshPtyProvider('target-1', asMux(legacyMux), undefined, 8)
  const served = new Set<string>()
  const release = vi.fn(() => served.clear())
  const routing: SshPtyLegacyRelayRouting = {
    attach: vi.fn(async (id: string) => {
      served.add(id)
      return { provider: legacy, release }
    }),
    providerFor: (id) => (served.has(id) ? legacy : undefined),
    track: (id, request) => (served.has(id) ? request(legacy) : undefined),
    // The old relay holds HELD; a short-lived route stops it there.
    stopHeld: vi.fn(async (id: string, stop: (provider: SshPtyProvider) => Promise<void>) => {
      if (id !== HELD) {
        return { stopped: false as const, reachable: true }
      }
      await stop(legacy)
      return { stopped: true as const }
    }),
    onExit: () => () => {},
    servedProviders: () => (served.size > 0 ? [legacy] : []),
    dispose: vi.fn()
  }
  provider.setLegacyRelayRouting(routing)
  return { provider, legacy, currentMux, legacyMux, routing, release, served }
}

describe('SshPtyProvider delegation to an earlier build relay', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reattaches a PTY the current relay holds for an older relay through that relay', async () => {
    currentRelayHoldsTheId()
    const { provider, legacy, routing } = setup()
    const legacySpawn = vi.spyOn(legacy, 'spawn').mockResolvedValue({ id: HELD, isReattach: true })

    await expect(provider.spawn({ sessionId: HELD, cols: 80, rows: 24 })).resolves.toEqual({
      id: HELD,
      isReattach: true
    })
    expect(routing.attach).toHaveBeenCalledWith(HELD)
    expect(legacySpawn).toHaveBeenCalledWith({ sessionId: HELD, cols: 80, rows: 24 })
  })

  it('keeps the held refusal when no older relay holds the PTY', async () => {
    currentRelayHoldsTheId()
    const { provider, routing } = setup()
    vi.mocked(routing.attach).mockResolvedValueOnce(null)

    await expect(provider.spawn({ sessionId: HELD, cols: 80, rows: 24 })).rejects.toBeInstanceOf(
      SshPtyHeldByPreviousRelayError
    )
  })

  it('releases the route when the attach through it fails', async () => {
    currentRelayHoldsTheId()
    const { provider, legacy, release } = setup()
    vi.spyOn(legacy, 'spawn').mockRejectedValue(new Error('PTY "pty2:old:1" not found'))

    await expect(provider.spawn({ sessionId: HELD, cols: 80, rows: 24 })).rejects.toThrow(
      'not found'
    )
    expect(release).toHaveBeenCalled()
  })

  it('sends a served PTY’s input, size and acks to the older relay only', () => {
    const { provider, currentMux, legacyMux, served } = setup()
    served.add(HELD)

    provider.resize(HELD, 100, 30)
    provider.acknowledgeDataEvent(HELD, 64)
    provider.resize(CURRENT, 90, 20)

    expect(legacyMux.notify).toHaveBeenCalledWith('pty.resize', {
      id: 'pty2:old:1',
      cols: 100,
      rows: 30
    })
    expect(legacyMux.notify).toHaveBeenCalledWith('pty.ackData', {
      id: 'pty2:old:1',
      charCount: 64
    })
    expect(currentMux.notify).toHaveBeenCalledWith('pty.resize', {
      id: 'pty2:new:1',
      cols: 90,
      rows: 20
    })
    expect(currentMux.notify).not.toHaveBeenCalledWith(
      'pty.resize',
      expect.objectContaining({ id: 'pty2:old:1' })
    )
    expect(provider.hasPty(HELD)).toBe(true)
  })

  it('lists served PTYs beside the current relay’s own', async () => {
    const { provider, currentMux, legacyMux, served } = setup()
    served.add(HELD)
    currentMux.request.mockResolvedValueOnce([{ id: 'pty2:new:1', cwd: '/', title: 'sh' }])
    legacyMux.request.mockResolvedValueOnce([
      { id: 'pty2:old:1', cwd: '/', title: 'sh' },
      { id: 'pty2:old:2', cwd: '/', title: 'sh' }
    ])

    const listed = await provider.listProcesses()

    expect(listed.map((row) => row.id)).toEqual([CURRENT, HELD])
  })

  it('answers owner listings from the serving relay and never serializes its PTYs here', async () => {
    const { provider, legacy, currentMux, served } = setup()
    served.add(HELD)
    const legacyListings = vi
      .spyOn(legacy, 'providesAgentSessionOwnerListings')
      .mockReturnValue(true)
    currentMux.request.mockResolvedValueOnce('[]')

    expect(provider.providesAgentSessionOwnerListings(HELD)).toBe(true)
    expect(legacyListings).toHaveBeenCalledWith(HELD)
    await provider.serialize([HELD, CURRENT])
    expect(currentMux.request).toHaveBeenCalledWith('pty.serialize', { ids: ['pty2:new:1'] })
  })

  it('refuses a second routing install', () => {
    const { provider, routing } = setup()
    expect(() => provider.setLegacyRelayRouting(routing)).toThrow(
      'ssh_pty_legacy_relay_routing_already_installed'
    )
  })

  it('fails the listing when an older relay cannot answer, so its PTYs read unverifiable', async () => {
    const { provider, currentMux, legacyMux, served } = setup()
    served.add(HELD)
    currentMux.request.mockResolvedValueOnce([{ id: 'pty2:new:1', cwd: '/', title: 'sh' }])
    legacyMux.request.mockRejectedValueOnce(new Error('relay timed out'))

    await expect(provider.listProcesses()).rejects.toThrow('relay timed out')
  })

  it('closes its routes with the provider', () => {
    const { provider, routing } = setup()
    provider.dispose()
    expect(routing.dispose).toHaveBeenCalled()
  })

  it('reads a class router through its own instance, as the session installs it', () => {
    const currentMux = createMockMux()
    const provider = new SshPtyProvider('target-1', asMux(currentMux), undefined, 7)
    provider.setLegacyRelayRouting(
      new SshLegacyRelayRouter({
        targetId: 'target-1',
        endpoints: async () => [],
        openRoute: async () => null
      })
    )

    provider.acknowledgeDataEvent(CURRENT, 32)

    expect(currentMux.notify).toHaveBeenCalledWith('pty.ackData', {
      id: 'pty2:new:1',
      charCount: 32
    })
  })

  it('refuses input to a held PTY no older relay serves, instead of dropping it silently', async () => {
    currentRelayHoldsTheId()
    const { provider, currentMux, routing } = setup()
    vi.mocked(routing.attach).mockResolvedValueOnce(null)
    await expect(provider.spawn({ sessionId: HELD, cols: 80, rows: 24 })).rejects.toBeInstanceOf(
      SshPtyHeldByPreviousRelayError
    )

    expect(provider.write(HELD, 'ls\n')).toBe(false)
    expect(provider.write('pty2:old:1', 'ls\n')).toBe(false)
    await expect(provider.writeWithSettlement(HELD, 'ls\n')).resolves.toMatchObject({
      outcome: 'refused',
      reason: 'endpoint_awaiting_recovery'
    })
    expect(currentMux.notify).not.toHaveBeenCalledWith('pty.data', expect.anything())
    expect(provider.write(CURRENT, 'ls\n')).toBe(true)
  })

  it('delivers input once a reconnect routes the held PTY to the older relay', async () => {
    const { provider, legacyMux, routing } = setup()
    vi.mocked(routing.attach).mockResolvedValueOnce(null)
    await expect(attachHeldPtyThroughPreviousRelay(provider, HELD)).resolves.toBeNull()
    expect(provider.write(HELD, 'ls\n')).toBe(false)

    legacyMux.request.mockResolvedValueOnce({ incarnationId: 'inc-old' })
    await expect(attachHeldPtyThroughPreviousRelay(provider, HELD)).resolves.toMatchObject({
      incarnationId: 'inc-old'
    })
    expect(provider.write(HELD, 'ls\n')).toBe(true)
    expect(legacyMux.notify).toHaveBeenCalledWith('pty.data', { id: 'pty2:old:1', data: 'ls\n' })
  })

  it('stops a served PTY on the older relay, never the current one', async () => {
    const { provider, currentMux, legacyMux, served } = setup()
    served.add(HELD)

    await provider.shutdown(HELD, { immediate: true })

    expect(legacyMux.request).toHaveBeenCalledWith(
      'pty.shutdown',
      expect.objectContaining({ id: 'pty2:old:1', immediate: true }),
      undefined
    )
    expect(currentMux.request).not.toHaveBeenCalledWith(
      'pty.shutdown',
      expect.anything(),
      undefined
    )
  })

  it('finds the older relay for a stop on a PTY no pane resumed this connection', async () => {
    const { provider, legacyMux, routing } = setup()

    await provider.shutdown(HELD, { immediate: false })

    expect(routing.stopHeld).toHaveBeenCalledWith(HELD, expect.any(Function))
    expect(routing.attach).not.toHaveBeenCalled()
    expect(legacyMux.request).toHaveBeenCalledWith(
      'pty.shutdown',
      expect.objectContaining({ id: 'pty2:old:1' }),
      undefined
    )
  })

  it('refuses a stop for a held PTY no older relay can serve, instead of reporting it stopped', async () => {
    const { provider, currentMux, routing } = setup()
    vi.mocked(routing.attach).mockResolvedValue(null)
    vi.mocked(routing.stopHeld).mockResolvedValue({ stopped: false, reachable: true })
    await expect(attachHeldPtyThroughPreviousRelay(provider, HELD)).resolves.toBeNull()

    await expect(provider.shutdown(HELD, { immediate: true })).rejects.toBeInstanceOf(
      SshPtyHeldByPreviousRelayError
    )
    expect(currentMux.request).not.toHaveBeenCalledWith(
      'pty.shutdown',
      expect.anything(),
      undefined
    )
  })

  it('hears exits the older relays report, so a stop can confirm them', () => {
    const currentMux = createMockMux()
    const provider = new SshPtyProvider('target-1', asMux(currentMux), undefined, 7)
    const exitListeners: Parameters<SshPtyProvider['onExit']>[0][] = []
    provider.setLegacyRelayRouting({
      attach: async () => null,
      providerFor: () => undefined,
      track: () => undefined,
      stopHeld: async () => ({ stopped: false, reachable: true }),
      onExit: (listener) => {
        exitListeners.push(listener)
        return () => {}
      },
      servedProviders: () => [],
      dispose: () => {}
    })
    const heard = vi.fn()
    provider.onExit(heard)

    const exit = { id: HELD, code: 0, providerGeneration: 8, ptyIncarnation: 'inc-old' }
    exitListeners.forEach((listener) => listener(exit))

    expect(heard).toHaveBeenCalledWith(exit)
  })

  it('refuses a stop when an older relay that may hold the PTY cannot be asked', async () => {
    const { provider, currentMux, routing } = setup()
    vi.mocked(routing.stopHeld).mockResolvedValue({ stopped: false, reachable: false })

    await expect(provider.shutdown(CURRENT, { immediate: true })).rejects.toBeInstanceOf(
      SshPtyHeldByPreviousRelayError
    )
    expect(currentMux.request).not.toHaveBeenCalledWith(
      'pty.shutdown',
      expect.anything(),
      undefined
    )
  })

  it('stops an id no relay holds on the current relay', async () => {
    const { provider, currentMux } = setup()

    await provider.shutdown(CURRENT, { immediate: true })

    expect(currentMux.request).toHaveBeenCalledWith(
      'pty.shutdown',
      expect.objectContaining({ id: 'pty2:new:1' }),
      undefined
    )
  })

  it('reads a stop whose bridge dropped mid-request as unverifiable, not failed', async () => {
    const { provider, legacyMux, served } = setup()
    served.add(HELD)
    legacyMux.request.mockRejectedValueOnce(
      Object.assign(new Error('Multiplexer disposed'), { code: 'DISPOSED' })
    )

    await expect(provider.shutdown(HELD, { immediate: true })).rejects.toBeInstanceOf(
      SshPtyHeldByPreviousRelayError
    )
  })
})
