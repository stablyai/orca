import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import { PROTOCOL_VERSION } from './daemon-protocol-version'

function setup(kind: 'router' | 'degraded') {
  const currentSessions: string[] = []
  const legacySessions = ['shared']
  const current = createAdapter('current', currentSessions, undefined, PROTOCOL_VERSION)
  const legacy = createAdapter('legacy', legacySessions, undefined, PROTOCOL_VERSION)
  const fallback = createAdapter('fallback')
  const provider =
    kind === 'router'
      ? new DaemonPtyRouter({ current, legacy: [legacy] })
      : new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
  const discover = () =>
    provider instanceof DaemonPtyRouter
      ? provider.discoverLegacySessions()
      : provider.discoverDaemonSessions()
  return { current, legacy, fallback, currentSessions, legacySessions, provider, discover }
}

const request = {
  id: 'shared',
  expectedIncarnationId: 'old',
  requireNoAgentOwner: true,
  requireUnattached: true
}

it('revokes incarnation proof when a synthetic exit is followed by owner adoption', async () => {
  const currentSessions = ['shared']
  const legacySessions: string[] = []
  const current = createAdapter('current', currentSessions, undefined, PROTOCOL_VERSION)
  const legacy = createAdapter('legacy', legacySessions, undefined, PROTOCOL_VERSION)
  const provider = new DegradedDaemonPtyProvider({
    current,
    legacy: [legacy],
    fallback: createAdapter('fallback')
  })
  vi.mocked(current.listProcesses).mockResolvedValue([
    { id: 'shared', incarnationId: 'old', cwd: '', title: 'old' }
  ])
  await provider.discoverDaemonSessions()
  expect(provider.supportsFencedTermination('shared')).toBe(true)

  provider.fanoutCurrentDaemonSyntheticExits(-1, { replacedByRestart: true })
  currentSessions.splice(0)
  vi.mocked(current.listProcesses).mockResolvedValue([])
  legacySessions.push('shared')
  vi.mocked(legacy.listProcesses).mockResolvedValue([
    { id: 'shared', incarnationId: 'new', cwd: '', title: 'new' }
  ])
  provider.write('shared', 'replacement input')

  expect(legacy.write).toHaveBeenCalledExactlyOnceWith('shared', 'replacement input')
  expect(provider.supportsFencedTermination('shared')).toBe(false)
  expect(provider.providesAgentSessionOwnerListings('shared')).toBe(false)
  await expect(provider.killFenced(request)).resolves.toEqual({
    outcome: 'refused',
    reason: 'replaced'
  })
  expect(current.killFenced).not.toHaveBeenCalled()
  expect(legacy.killFenced).not.toHaveBeenCalled()
})

describe.each(['router', 'degraded'] as const)('%s inventory input authority', (kind) => {
  afterEach(() => vi.useRealTimers())

  it('preserves a legacy input recipient without incarnation metadata across diagnostic reads', async () => {
    const { provider, discover, current, legacy, currentSessions } = setup(kind)
    await discover()
    provider.write('shared', 'before')
    currentSessions.push('shared')

    const diagnostic = await provider.listProcesses({ includeUnrouted: true })
    provider.write('shared', 'after')

    expect(vi.mocked(legacy.write).mock.calls).toEqual([
      ['shared', 'before'],
      ['shared', 'after']
    ])
    expect(current.write).not.toHaveBeenCalled()
    expect(diagnostic).toHaveLength(2)
    expect(diagnostic.every((row) => row.routed === undefined)).toBe(true)
    expect(provider.supportsFencedTermination('shared')).toBe(false)
    expect(provider.providesAgentSessionOwnerListings('shared')).toBe(false)
    await expect(provider.listProcesses()).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
    await expect(provider.killFenced(request)).resolves.toEqual({
      outcome: 'refused',
      reason: 'unverifiable'
    })
    expect(current.killFenced).not.toHaveBeenCalled()
    expect(legacy.killFenced).not.toHaveBeenCalled()
  })

  it('retains input authority without certifying an incarnation reported by two daemons', async () => {
    const { provider, discover, current, legacy } = setup(kind)
    const row = { id: 'shared', incarnationId: 'old', cwd: '', title: 'shell' }
    vi.mocked(legacy.listProcesses).mockResolvedValue([row])
    await discover()
    vi.mocked(current.listProcesses).mockResolvedValue([row])

    const diagnostic = await provider.listProcesses({ includeUnrouted: true })
    provider.write('shared', 'still legacy')

    expect(diagnostic.every((entry) => entry.routed === undefined)).toBe(true)
    expect(provider.supportsFencedTermination('shared')).toBe(false)
    expect(provider.providesAgentSessionOwnerListings('shared')).toBe(false)
    expect(legacy.write).toHaveBeenCalledExactlyOnceWith('shared', 'still legacy')
    expect(current.write).not.toHaveBeenCalled()
    await expect(provider.listProcesses()).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
    await expect(provider.killFenced(request)).resolves.toEqual({
      outcome: 'refused',
      reason: 'unverifiable'
    })
    expect(current.killFenced).not.toHaveBeenCalled()
    expect(legacy.killFenced).not.toHaveBeenCalled()
  })

  it('does not redirect input or terminate a newer replacement discovered on another daemon', async () => {
    const { provider, discover, current, legacy } = setup(kind)
    vi.mocked(legacy.listProcesses).mockResolvedValue([
      { id: 'shared', incarnationId: 'old', cwd: '', title: 'old' }
    ])
    await discover()
    vi.mocked(legacy.listProcesses).mockResolvedValue([])
    vi.mocked(current.listProcesses).mockResolvedValue([
      { id: 'shared', incarnationId: 'new', cwd: '', title: 'new' }
    ])

    await expect(provider.listProcesses({ includeUnrouted: true })).resolves.toEqual([
      expect.objectContaining({ incarnationId: 'new' })
    ])
    provider.write('shared', 'established recipient')
    expect(legacy.write).toHaveBeenCalledExactlyOnceWith('shared', 'established recipient')
    expect(current.write).not.toHaveBeenCalled()
    await expect(provider.listProcesses()).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
    await expect(provider.killFenced(request)).resolves.toEqual({
      outcome: 'refused',
      reason: 'replaced'
    })
    expect(current.killFenced).not.toHaveBeenCalled()
    expect(legacy.killFenced).not.toHaveBeenCalled()
  })

  it('keeps input authority when a diagnostic inventory is incomplete', async () => {
    const { provider, discover, current, legacy } = setup(kind)
    await discover()
    vi.mocked(current.listProcesses).mockRejectedValue(new Error('inventory unavailable'))

    await expect(provider.listProcesses({ includeUnrouted: true })).rejects.toThrow(
      'inventory unavailable'
    )
    provider.write('shared', 'still legacy')
    expect(legacy.write).toHaveBeenCalledExactlyOnceWith('shared', 'still legacy')
    expect(current.write).not.toHaveBeenCalled()
  })
})
