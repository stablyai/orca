/**
 * An undo refused after the host's terminals were put to sleep (#35369's gap): the refusal says so,
 * since the project stays moved and its host terminals resume only when it is opened there.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslMoveHostCopyStop } from '../persistence/moving-wsl-projects/wsl-move-host-copy-stop'

type Move = {
  migrationId: string
  phase: string
  journalKey: string
  destinationEnvironmentId: string
  manifest: {
    source: { distro: string; scopeRepoIds: string[]; scopeFolderWorkspaceIds: string[] }
  }
}

const journal = vi.hoisted(() => ({
  chain: new Array<Move>(),
  released: new Array<string>(),
  // Moves whose release write fails, after their host terminals stopped.
  failing: new Set<string>()
}))
const window = vi.hoisted(() => ({ reloads: 0 }))

vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: () => [{ id: 'wsl:Ubuntu' }]
}))
vi.mock('../wsl/wsl-host-kept-for-peers', () => ({ wasWslHostKeptForPeers: () => false }))
vi.mock('../persistence/moving-wsl-projects/wsl-move-cutover-journal', () => ({
  listWslMoveCutoverChain: () => [...journal.chain]
}))
vi.mock('../persistence/moving-wsl-projects/wsl-move-use-locally', () => ({
  findWslMovedProjectMove: () => ({ move: journal.chain.at(-1) }),
  wslMoveWorkspacesInScope: () => [],
  wslMoveReleaseRefusal: (_userData: string, candidate: Move) =>
    journal.chain.at(-1)?.migrationId === candidate.migrationId
      ? null
      : { released: false, reason: 'superseded' },
  releaseWslMove: (_userData: string, candidate: Move) => {
    if (journal.failing.has(candidate.migrationId)) {
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
  fenceHostSpawnsForWslMoveUndo: () => () => {}
}))
vi.mock('../persistence/moving-wsl-projects/wsl-move-window-write-hold', () => ({
  holdWslMoveWindowWrites: () => {},
  reloadWslMoveWindowWithWritesHeld: () => {
    window.reloads++
  }
}))

import { releaseWslMoveChainHere, releaseWslMovedProjectHere } from './wsl-move-release-here'

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

function hostStops(stop: WslMoveHostCopyStop) {
  const stopHostCopies = vi.fn(async () => stop)
  return { stopHostCopies, ports: () => ({ stopHostCopies }) }
}

const SLEPT = { outcome: 'stopped', slept: true } as const

beforeEach(() => {
  journal.chain = [move('m1', 'r1'), move('m2', 'r2')]
  journal.released = []
  journal.failing = new Set()
  window.reloads = 0
})

describe("an undo refused after the host's terminals stopped", () => {
  it('says they are asleep when the release then fails', async () => {
    journal.failing.add('m2')
    const { ports } = hostStops(SLEPT)
    expect(await releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], ports)).toEqual({
      released: false,
      reason: 'failed',
      detail: 'journal',
      hostTerminalsAsleep: true
    })
    expect(window.reloads).toBe(0)
  })

  // The sleep reached a running workspace before the host stopped answering or the wait ran out.
  it.each([
    ['unreachable', 'host-unreachable'],
    ['still-running', 'host-still-running']
  ] as const)('says they are asleep when the stop then ends %s', async (outcome, reason) => {
    const { ports } = hostStops({ outcome, slept: true })
    expect(await releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], ports)).toEqual({
      released: false,
      reason,
      hostTerminalsAsleep: true
    })
    expect(journal.released).toEqual([])
  })

  it('says nothing about sleep when the stop ended before any sleep', async () => {
    const { ports } = hostStops('unreachable')
    const result = await releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], ports)
    expect(result).toEqual({ released: false, reason: 'host-unreachable' })
  })

  it('says nothing about sleep when the host had nothing to put to sleep', async () => {
    journal.failing.add('m2')
    const { ports } = hostStops('stopped')
    const result = await releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], ports)
    expect(result).toMatchObject({ released: false, reason: 'failed' })
    expect(result).not.toHaveProperty('hostTerminalsAsleep')
  })

  it('says nothing about sleep for a refusal before the stop', async () => {
    const { stopHostCopies, ports } = hostStops(SLEPT)
    const result = await releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], () => ({
      ...ports(),
      // A newer move lands before the stop, so the late check refuses.
      stopHostAutomations: async () => {
        journal.chain.push(move('m3', 'r3'))
        return { outcome: 'stopped' as const, restore: async () => {}, applyHere: () => () => {} }
      }
    }))
    expect(result).toMatchObject({ released: false, reason: 'superseded' })
    expect(result).not.toHaveProperty('hostTerminalsAsleep')
    expect(stopHostCopies).not.toHaveBeenCalled()
  })

  it('flags a Restore whose older move fails after its stop, and still reloads for what came back', async () => {
    journal.failing.add('m1')
    const { stopHostCopies, ports } = hostStops(SLEPT)
    expect(await releaseWslMoveChainHere('/user-data', 'Ubuntu', [], ports)).toEqual({
      released: false,
      reason: 'failed',
      detail: 'journal',
      hostTerminalsAsleep: true
    })
    expect(stopHostCopies).toHaveBeenCalledTimes(2)
    expect(journal.released).toEqual(['m2'])
    expect(window.reloads).toBe(1)
  })
})
