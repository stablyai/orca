import { describe, expect, it, vi } from 'vitest'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { PROTOCOL_VERSION } from './daemon-protocol-version'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'

const process = (incarnationId: string) => ({
  id: 'session',
  incarnationId,
  cwd: '/workspace',
  title: incarnationId
})

function setup() {
  const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
  const legacy = createAdapter('legacy', [], undefined, PROTOCOL_VERSION - 1)
  const fallback = createAdapter('fallback', [], undefined, 1)
  const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
  return { current, legacy, fallback, provider }
}

describe('degraded daemon inventory ownership', () => {
  it('discovers new owners and dispatches checked termination without a second inventory', async () => {
    const { current, legacy, fallback, provider } = setup()
    vi.mocked(current.listProcesses).mockResolvedValue([process('current')])

    await expect(provider.listProcesses()).resolves.toEqual([process('current')])
    expect(provider.supportsFencedTermination('session')).toBe(true)
    expect(provider.providesAgentSessionOwnerListings('session')).toBe(true)
    const request = {
      id: 'session',
      expectedIncarnationId: 'current',
      requireNoAgentOwner: true,
      requireUnattached: true
    }
    await expect(provider.killFenced(request)).resolves.toEqual({ outcome: 'ended' })
    expect(current.killFenced).toHaveBeenCalledExactlyOnceWith(request)
    for (const source of [current, legacy, fallback]) {
      expect(source.listProcesses).toHaveBeenCalledOnce()
      expect(source.spawn).not.toHaveBeenCalled()
      expect(source.attach).not.toHaveBeenCalled()
    }
  })

  it('preserves the exact established owner when another generation reuses its id', async () => {
    const { current, legacy, provider } = setup()
    vi.mocked(current.listProcesses).mockResolvedValue([process('current')])
    await provider.discoverDaemonSessions()
    vi.mocked(legacy.listProcesses).mockResolvedValue([process('legacy')])

    await expect(provider.listProcesses()).resolves.toEqual([process('current')])
    provider.write('session', 'hello')
    expect(current.write).toHaveBeenCalledExactlyOnceWith('session', 'hello')
    expect(legacy.write).not.toHaveBeenCalled()
  })

  it('shares routed, diagnostic and exact reattach observations in degraded mode', async () => {
    const { current, legacy, fallback, provider } = setup()
    vi.mocked(current.listProcesses).mockResolvedValue([process('current')])
    vi.mocked(current.spawn).mockResolvedValue({
      id: 'session',
      incarnationId: 'current',
      isReattach: true
    })
    const [routed, diagnostic, attached] = await Promise.all([
      provider.listProcesses(),
      provider.listProcesses({ includeUnrouted: true }),
      provider.spawn({
        sessionId: 'session',
        expectedIncarnationId: 'current',
        expectedIncarnationIsAuthoritative: true,
        attachOnly: true,
        cols: 80,
        rows: 24
      })
    ])
    expect(routed).toEqual([process('current')])
    expect(diagnostic).toEqual([expect.objectContaining({ ...process('current'), routed: true })])
    expect(attached.incarnationId).toBe('current')
    for (const source of [current, legacy, fallback]) {
      expect(source.listProcesses).toHaveBeenCalledOnce()
    }
  })

  it.each(['different', 'identical'])(
    'refuses ambiguous inventory and capabilities without adopting the first cached owner (%s)',
    async (incarnations) => {
      const { current, legacy, provider } = setup()
      vi.mocked(current.listProcesses).mockResolvedValue([process('current')])
      vi.mocked(legacy.listProcesses).mockResolvedValue([
        process(incarnations === 'identical' ? 'current' : 'legacy')
      ])
      vi.mocked(current.hasPty).mockReturnValue(true)
      vi.mocked(legacy.hasPty).mockReturnValue(true)

      await expect(provider.listProcesses()).rejects.toBeInstanceOf(
        TerminalSessionOwnerUnverifiedError
      )
      await expect(provider.listProcesses({ includeUnrouted: true })).resolves.toEqual([
        expect.objectContaining(process('current')),
        expect.objectContaining(process(incarnations === 'identical' ? 'current' : 'legacy'))
      ])
      await expect(provider.listProcesses()).rejects.toBeInstanceOf(
        TerminalSessionOwnerUnverifiedError
      )
      expect(provider.providesAgentSessionOwnerListings('session')).toBe(false)
      expect(provider.supportsFencedTermination('session')).toBe(false)
      await expect(
        provider.killFenced({
          id: 'session',
          expectedIncarnationId: 'current',
          requireNoAgentOwner: true,
          requireUnattached: true
        })
      ).resolves.toEqual(
        incarnations === 'identical'
          ? { outcome: 'refused', reason: 'unverifiable' }
          : { outcome: 'ended' }
      )
      expect(legacy.killFenced).not.toHaveBeenCalled()
    }
  )
})
