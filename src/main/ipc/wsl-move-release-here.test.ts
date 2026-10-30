import { beforeEach, describe, expect, it, vi } from 'vitest'

type Move = {
  migrationId: string
  phase: string
  journalKey: string
  destinationEnvironmentId: string
  manifest: {
    source: { distro: string; scopeRepoIds: string[]; scopeFolderWorkspaceIds: string[] }
  }
}

const journal = vi.hoisted(() => ({ chain: new Array<Move>(), released: new Array<string>() }))
const window = vi.hoisted(() => ({
  reloads: 0,
  fences: 0,
  fencesReleased: 0,
  steps: new Array<string>()
}))
const releaseFails = vi.hoisted(() => ({ value: false }))
const host = vi.hoisted(() => ({ listed: true, keptForPeers: false }))
vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: () => (host.listed ? [{ id: 'wsl:Ubuntu' }] : [])
}))
vi.mock('../wsl/wsl-host-kept-for-peers', () => ({
  wasWslHostKeptForPeers: () => host.keptForPeers
}))

function move(migrationId: string, repoId: string): Move {
  return {
    migrationId,
    phase: 'retained',
    journalKey: 'local-wsl:ubuntu',
    destinationEnvironmentId: 'wsl:Ubuntu',
    manifest: {
      source: { distro: 'Ubuntu', scopeRepoIds: [repoId], scopeFolderWorkspaceIds: [] }
    }
  }
}

vi.mock('../persistence/moving-wsl-projects/wsl-move-cutover-journal', () => ({
  listWslMoveCutoverChain: () => [...journal.chain]
}))
vi.mock('../persistence/moving-wsl-projects/wsl-move-use-locally', () => ({
  findWslMovedProjectMove: () => ({ move: journal.chain.at(-1) }),
  wslMoveWorkspacesInScope: () => [],
  // Only the newest move of the chain may come back, as the real journal enforces.
  wslMoveReleaseRefusal: (_userData: string, candidate: Move) =>
    journal.chain.at(-1)?.migrationId === candidate.migrationId
      ? null
      : { released: false, reason: 'superseded' },
  releaseWslMove: (_userData: string, candidate: Move) => {
    if (releaseFails.value) {
      return { released: false, reason: 'failed', detail: 'journal' }
    }
    journal.chain = journal.chain.filter((entry) => entry.migrationId !== candidate.migrationId)
    journal.released.push(candidate.migrationId)
    return {
      released: true,
      distro: 'Ubuntu',
      repoIds: candidate.manifest.source.scopeRepoIds,
      folderWorkspaceIds: []
    }
  }
}))
vi.mock('../persistence/moving-wsl-projects/wsl-move-undo-spawn-fence', () => ({
  fenceHostSpawnsForWslMoveUndo: () => {
    window.fences++
    return () => {
      window.fencesReleased++
    }
  }
}))
vi.mock('../persistence/moving-wsl-projects/wsl-move-window-write-hold', () => ({
  holdWslMoveWindowWrites: () => {
    window.steps.push('hold')
  },
  reloadWslMoveWindowWithWritesHeld: () => {
    window.reloads++
    window.steps.push('reload')
  }
}))

import {
  onWslMoveReleasedByUser,
  releaseWslMoveChainHere,
  releaseWslMovedProjectHere
} from './wsl-move-release-here'

const undoPorts = () => ({ stopHostCopies: vi.fn(async () => 'stopped' as const) })

beforeEach(() => {
  journal.chain = [move('m1', 'r1'), move('m2', 'r2')]
  journal.released = []
  window.reloads = 0
  window.fences = 0
  window.fencesReleased = 0
  releaseFails.value = false
  window.steps = []
  host.listed = true
  host.keptForPeers = false
})

describe('releasing moved projects here', () => {
  // Review #5: one Restore must bring back every finished move, not only the newest.
  it('releases a whole chain newest first with one reload', async () => {
    const result = await releaseWslMoveChainHere('/user-data', 'Ubuntu', [], undoPorts)
    expect(journal.released).toEqual(['m2', 'm1'])
    expect(result).toEqual({
      released: true,
      distro: 'Ubuntu',
      repoIds: ['r2', 'r1'],
      folderWorkspaceIds: []
    })
    expect(window.reloads).toBe(1)
  })

  it('reloads for what came back even when an older move is refused', async () => {
    const stopHostCopies = vi
      .fn<() => Promise<'stopped' | 'unreachable'>>()
      .mockResolvedValueOnce('stopped')
      .mockResolvedValueOnce('unreachable')
    const result = await releaseWslMoveChainHere('/user-data', 'Ubuntu', [], () => ({
      stopHostCopies
    }))
    expect(journal.released).toEqual(['m2'])
    expect(result).toMatchObject({ released: false, reason: 'host-unreachable' })
    expect(window.reloads).toBe(1)
  })

  it("refuses before the host's terminals stop when a newer move lands while automations stop", async () => {
    const stopHostCopies = vi.fn(async () => 'stopped' as const)
    const restore = vi.fn(async () => {})
    const result = await releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], () => ({
      stopHostCopies,
      stopHostAutomations: async () => {
        // Another move of the distro journaled after the undo's first check.
        journal.chain.push(move('m3', 'r3'))
        return { outcome: 'stopped' as const, restore, applyHere: () => () => {} }
      }
    }))
    expect(result).toMatchObject({ released: false, reason: 'superseded' })
    expect(stopHostCopies).not.toHaveBeenCalled()
    expect(restore).toHaveBeenCalledOnce()
  })

  // R39: removed here but kept running for another Orca, so only re-adding the host reaches it.
  it('says a removed host kept for another Orca needs re-adding, not just connecting', async () => {
    host.listed = false
    host.keptForPeers = true
    const result = await releaseWslMoveChainHere('/user-data', 'Ubuntu', [], () => ({
      stopHostCopies: vi.fn(async () => 'unreachable' as const)
    }))
    expect(result).toMatchObject({
      released: false,
      reason: 'host-unreachable',
      detail: 'host-kept-for-peers'
    })
    // A host still listed that just isn't answering keeps the plain refusal.
    host.listed = true
    const unanswered = await releaseWslMoveChainHere('/user-data', 'Ubuntu', [], () => ({
      stopHostCopies: vi.fn(async () => 'unreachable' as const)
    }))
    expect(unanswered).not.toHaveProperty('detail')
  })

  // Review #2: only the user's "Use on this computer again" parks the distro; Restore does not.
  it('tells listeners about a user release and not about a Restore', async () => {
    const heard = vi.fn()
    const stop = onWslMoveReleasedByUser(heard)
    await releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], undoPorts)
    expect(heard).toHaveBeenCalledWith('Ubuntu')
    heard.mockClear()
    await releaseWslMoveChainHere('/user-data', 'Ubuntu', [], undoPorts)
    expect(heard).not.toHaveBeenCalled()
    stop()
  })

  // verify-15b 6c: focus left on the host copy reopened its pane after the reload and resumed
  // the agent there beside the one restored here.
  it('returns focus from each released host copy after holding writes and before the reload', async () => {
    const refocusHere = vi.fn((released: Move) => {
      window.steps.push(`refocus ${released.migrationId}`)
    })
    const result = await releaseWslMoveChainHere('/user-data', 'Ubuntu', [], () => ({
      stopHostCopies: vi.fn(async () => 'stopped' as const),
      refocusHere
    }))
    expect(result).toMatchObject({ released: true })
    expect(window.steps).toEqual(['hold', 'refocus m2', 'refocus m1', 'reload'])
  })

  it('returns no focus for a move that did not come back', async () => {
    const refocusHere = vi.fn()
    const stopHostCopies = vi
      .fn<() => Promise<'stopped' | 'unreachable'>>()
      .mockResolvedValueOnce('stopped')
      .mockResolvedValueOnce('unreachable')
    await releaseWslMoveChainHere('/user-data', 'Ubuntu', [], () => ({
      stopHostCopies,
      refocusHere
    }))
    expect(refocusHere.mock.calls.map(([released]) => released.migrationId)).toEqual(['m2'])
  })

  const automationsOff = (
    onRestore = vi.fn(async () => {}),
    applyHere = vi.fn((): (() => void) => () => {})
  ) => ({
    outcome: 'stopped' as const,
    restore: onRestore,
    applyHere
  })

  it("turns each move's host automations off, then stops its terminals, then releases it", async () => {
    const steps: string[] = []
    const result = await releaseWslMoveChainHere('/user-data', 'Ubuntu', [], () => ({
      stopHostAutomations: vi.fn(async (stopped: Move) => {
        steps.push(`automations ${stopped.migrationId}`)
        return automationsOff()
      }),
      stopHostCopies: vi.fn(async (stopped: Move) => {
        expect(journal.released).not.toContain(stopped.migrationId)
        steps.push(`terminals ${stopped.migrationId}`)
        return 'stopped' as const
      })
    }))
    expect(result).toMatchObject({ released: true })
    // Partial chains stay per move: each step names only the move being released.
    expect(steps).toEqual(['automations m2', 'terminals m2', 'automations m1', 'terminals m1'])
  })

  // X1: a refused undo leaves the host's copies running.
  it('refuses with the host terminals untouched when the automations cannot go off', async () => {
    for (const [outcome, reason] of [
      ['unreachable', 'host-unreachable'],
      ['failed', 'failed']
    ] as const) {
      journal.chain = [move('m1', 'r1'), move('m2', 'r2')]
      journal.released = []
      window.reloads = 0
      let operatorCloses = 0
      const result = await releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], () => ({
        stopHostAutomations: vi.fn(async () => ({ outcome })),
        stopHostCopies: vi.fn(async () => {
          operatorCloses++
          return 'stopped' as const
        })
      }))
      expect(result).toMatchObject({ released: false, reason, detail: 'host-automations' })
      expect(operatorCloses).toBe(0)
      expect(journal.released).toEqual([])
      expect(window.reloads).toBe(0)
    }
  })

  it('turns the automations back on when the terminals then fail to stop', async () => {
    const restore = vi.fn(async () => {})
    const result = await releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], () => ({
      stopHostAutomations: vi.fn(async () => automationsOff(restore)),
      stopHostCopies: vi.fn(async () => 'still-running' as const)
    }))
    expect(result).toMatchObject({ released: false, reason: 'host-still-running' })
    expect(restore).toHaveBeenCalledOnce()
    expect(journal.released).toEqual([])
  })

  it('turns the automations back on, and undoes the write here, when the release then fails', async () => {
    releaseFails.value = true
    const restore = vi.fn(async () => {})
    const revertHere = vi.fn()
    const result = await releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], () => ({
      stopHostAutomations: vi.fn(async () =>
        automationsOff(
          restore,
          vi.fn(() => revertHere)
        )
      ),
      stopHostCopies: vi.fn(async () => 'stopped' as const)
    }))
    expect(result).toMatchObject({ released: false, reason: 'failed', detail: 'journal' })
    expect(revertHere).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()
    expect(window.fencesReleased).toBe(1)
  })

  it('names a host whose Remove is pending, touching nothing on it', async () => {
    const stopHostCopies = vi.fn(async () => 'stopped' as const)
    const result = await releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], () => ({
      stopHostAutomations: vi.fn(async () => ({ outcome: 'removal-pending' as const })),
      stopHostCopies
    }))
    expect(result).toMatchObject({
      released: false,
      reason: 'failed',
      detail: 'host-removal-pending'
    })
    expect(stopHostCopies).not.toHaveBeenCalled()
  })

  it('releases the spawn fence when a port throws', async () => {
    await expect(
      releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], () => ({
        stopHostAutomations: vi.fn(async () => {
          throw new Error('boom')
        }),
        stopHostCopies: vi.fn(async () => 'stopped' as const)
      }))
    ).rejects.toThrow('boom')
    expect(window.fences).toBe(1)
    expect(window.fencesReleased).toBe(1)
    expect(window.reloads).toBe(0)
  })

  it('applies the host automation states here as part of the release, never on a refusal', async () => {
    const applyHere = vi.fn((): (() => void) => {
      // After the terminals stopped, right before the release.
      expect(journal.released).not.toContain('m2')
      return () => {}
    })
    await releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], () => ({
      stopHostAutomations: vi.fn(async () => automationsOff(undefined, applyHere)),
      stopHostCopies: vi.fn(async () => 'stopped' as const)
    }))
    expect(applyHere).toHaveBeenCalledOnce()
    expect(journal.released).toContain('m2')

    journal.chain = [move('m1', 'r1'), move('m2', 'r2')]
    journal.released = []
    const refusedApply = vi.fn((): (() => void) => () => {})
    await releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], () => ({
      stopHostAutomations: vi.fn(async () => automationsOff(undefined, refusedApply)),
      stopHostCopies: vi.fn(async () => 'still-running' as const)
    }))
    expect(refusedApply).not.toHaveBeenCalled()
  })

  it('still turns the host automations back on when putting the copies here back throws', async () => {
    releaseFails.value = true
    const restore = vi.fn(async () => {})
    await expect(
      releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], () => ({
        stopHostAutomations: vi.fn(async () =>
          automationsOff(
            restore,
            vi.fn(() => () => {
              throw new Error('store busy')
            })
          )
        ),
        stopHostCopies: vi.fn(async () => 'stopped' as const)
      }))
    ).rejects.toThrow('store busy')
    expect(restore).toHaveBeenCalledOnce()
    expect(window.fencesReleased).toBe(1)
  })
})
