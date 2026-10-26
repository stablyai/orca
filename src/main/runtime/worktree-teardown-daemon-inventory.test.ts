import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from '../daemon/daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import { DegradedDaemonPtyProvider } from '../daemon/degraded-daemon-pty-provider'
import { killAllProcessesForWorktree } from './worktree-teardown'
import { registerPty, unregisterPty } from '../memory/pty-registry'

const worktreeId = 'repo::/projects/fix-favicon-clapping'
const unrelatedId = 'repo::/projects/team-automations@@duplicate'
const targetId = `${worktreeId}@@terminal`

function setup(kind: 'router' | 'degraded', targetIds: string[] = []) {
  const currentSessions = [unrelatedId, ...targetIds]
  const legacySessions = [unrelatedId]
  const current = createAdapter('current', currentSessions)
  const legacy = createAdapter('legacy', legacySessions)
  const provider =
    kind === 'router'
      ? new DaemonPtyRouter({ current, legacy: [legacy] })
      : new DegradedDaemonPtyProvider({
          current,
          legacy: [legacy],
          fallback: createAdapter('fallback', [])
        })
  return { provider, current, legacy, currentSessions, legacySessions }
}

describe.each(['router', 'degraded'] as const)('workspace deletion with %s inventory', (kind) => {
  afterEach(() => {
    unregisterPty(targetId)
  })

  it('removes a workspace with no terminals despite an unrelated ambiguous session', async () => {
    const { provider, currentSessions, legacySessions } = setup(kind)

    await expect(
      killAllProcessesForWorktree(worktreeId, {
        localProvider: provider,
        requirePhysicalStop: true
      })
    ).resolves.toEqual({ runtimeStopped: 0, providerStopped: 0, registryStopped: 0 })
    expect(currentSessions).toEqual([unrelatedId])
    expect(legacySessions).toEqual([unrelatedId])
    await expect(provider.listProcesses()).rejects.toThrow(unrelatedId)
  })

  it('stops the target terminal and preserves ambiguous sessions in other workspaces', async () => {
    const { provider, currentSessions, legacySessions } = setup(kind, [targetId])

    await expect(
      killAllProcessesForWorktree(worktreeId, {
        localProvider: provider,
        requirePhysicalStop: true
      })
    ).resolves.toEqual({ runtimeStopped: 0, providerStopped: 1, registryStopped: 0 })
    expect(currentSessions).toEqual([unrelatedId])
    expect(legacySessions).toEqual([unrelatedId])
  })

  it('still refuses deletion when the target terminal has ambiguous ownership', async () => {
    const { provider, currentSessions, legacySessions } = setup(kind, [targetId])
    legacySessions.push(targetId)

    await expect(
      killAllProcessesForWorktree(worktreeId, {
        localProvider: provider,
        requirePhysicalStop: true
      })
    ).rejects.toThrow(`Terminal session owner could not be verified: ${targetId}`)
    expect(currentSessions).toContain(targetId)
    expect(legacySessions).toContain(targetId)
  })

  it('refuses an ambiguous target even after establishing its legacy input route', async () => {
    const { provider, currentSessions, legacySessions } = setup(kind)
    legacySessions.push(targetId)
    await (provider instanceof DaemonPtyRouter
      ? provider.discoverLegacySessions()
      : provider.discoverDaemonSessions())
    currentSessions.push(targetId)
    await provider.listProcesses({ includeUnrouted: true })

    await expect(
      killAllProcessesForWorktree(worktreeId, {
        localProvider: provider,
        requirePhysicalStop: true
      })
    ).rejects.toThrow(`Terminal session owner could not be verified: ${targetId}`)
    expect(currentSessions).toContain(targetId)
    expect(legacySessions).toContain(targetId)
  })

  it('refuses a scoped target whose duplicate is routed to another workspace', async () => {
    const { provider, current, legacy } = setup(kind)
    vi.mocked(legacy.listProcesses).mockResolvedValue([
      {
        id: 'floating',
        incarnationId: 'legacy',
        cwd: '',
        title: 'shell',
        worktreeId: 'repo::/projects/other'
      }
    ])
    await (provider instanceof DaemonPtyRouter
      ? provider.discoverLegacySessions()
      : provider.discoverDaemonSessions())
    vi.mocked(current.listProcesses).mockResolvedValue([
      { id: 'floating', incarnationId: 'current', cwd: '', title: 'shell', worktreeId }
    ])

    await expect(
      killAllProcessesForWorktree(worktreeId, {
        localProvider: provider,
        requirePhysicalStop: true
      })
    ).rejects.toThrow('Terminal session owner could not be verified: floating')
    expect(current.shutdown).not.toHaveBeenCalled()
    expect(legacy.shutdown).not.toHaveBeenCalled()
  })

  it('does not omit another live target generation even when the input owner is exact', async () => {
    const { provider, current, legacy } = setup(kind)
    const old = { id: targetId, incarnationId: 'old', cwd: '', title: 'old' }
    vi.mocked(legacy.listProcesses).mockResolvedValue([old])
    await (provider instanceof DaemonPtyRouter
      ? provider.discoverLegacySessions()
      : provider.discoverDaemonSessions())
    vi.mocked(current.listProcesses).mockResolvedValue([
      { id: targetId, incarnationId: 'new', cwd: '', title: 'new' }
    ])
    await expect(provider.listProcesses()).resolves.toEqual([old])

    await expect(
      killAllProcessesForWorktree(worktreeId, {
        localProvider: provider,
        requirePhysicalStop: true
      })
    ).rejects.toThrow(`Terminal session owner could not be verified: ${targetId}`)
    expect(current.shutdown).not.toHaveBeenCalled()
    expect(legacy.shutdown).not.toHaveBeenCalled()
  })

  it.each(['metadata', 'cwd'] as const)(
    'retains %s ownership for older terminal IDs',
    async (via) => {
      const { provider, current, currentSessions, legacySessions } = setup(kind, ['floating'])
      vi.mocked(current.listProcesses).mockImplementation(async () =>
        currentSessions.map((id) => ({
          id,
          cwd: id === 'floating' && via === 'cwd' ? '/projects/fix-favicon-clapping/nested' : '',
          title: 'shell',
          ...(id === 'floating' && via === 'metadata' ? { worktreeId } : {})
        }))
      )

      await expect(
        killAllProcessesForWorktree(worktreeId, {
          localProvider: provider,
          requirePhysicalStop: true
        })
      ).resolves.toEqual({ runtimeStopped: 0, providerStopped: 1, registryStopped: 0 })
      expect(currentSessions).toEqual([unrelatedId])
      expect(legacySessions).toEqual([unrelatedId])
    }
  )

  it('verifies an absent stale terminal without requiring unrelated route authority', async () => {
    const { provider, currentSessions, legacySessions } = setup(kind)
    const onPtyStopped = vi.fn()
    vi.spyOn(provider, 'shutdown').mockRejectedValue(new Error('shutdown reply lost'))
    registerPty({ ptyId: targetId, worktreeId, sessionId: null, paneKey: null, pid: 100 })

    await expect(
      killAllProcessesForWorktree(worktreeId, {
        localProvider: provider,
        requirePhysicalStop: true,
        onPtyStopped
      })
    ).resolves.toEqual({ runtimeStopped: 0, providerStopped: 0, registryStopped: 0 })
    expect(onPtyStopped).toHaveBeenCalledExactlyOnceWith(targetId)
    expect(currentSessions).toEqual([unrelatedId])
    expect(legacySessions).toEqual([unrelatedId])
  })

  it('refuses deletion when a failed shutdown leaves the target terminal live', async () => {
    const { provider, currentSessions } = setup(kind, [targetId])
    vi.spyOn(provider, 'shutdown').mockRejectedValue(new Error('shutdown reply lost'))

    await expect(
      killAllProcessesForWorktree(worktreeId, {
        localProvider: provider,
        requirePhysicalStop: true
      })
    ).rejects.toThrow(`still live: ${targetId}`)
    expect(currentSessions).toContain(targetId)
  })

  it('still refuses deletion when a daemon cannot supply its inventory', async () => {
    const { provider, legacy } = setup(kind)
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('daemon unavailable'))

    await expect(
      killAllProcessesForWorktree(worktreeId, {
        localProvider: provider,
        requirePhysicalStop: true
      })
    ).rejects.toThrow('daemon unavailable')
  })
})
