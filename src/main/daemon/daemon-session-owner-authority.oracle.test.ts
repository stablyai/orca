import { expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../providers/types'
import { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

it('preserves A topology when compatible replacement B reports A absent', async () => {
  const persistedOwner = Object.freeze({
    executionHostId: 'local',
    ownerIncarnationId: 'daemon-a',
    sessionIncarnationId: 'session-a',
    logicalPtyId: 'logical-pty'
  })
  const replacementB = {
    listProcesses: vi.fn(async () => []),
    probePtyLiveness: vi.fn(async () => false)
  } as unknown as IPtyProvider
  const resolver = new DaemonSessionOwnerResolver([replacementB], new Map())
  const topology: {
    savedRows: string[]
    tabBindings: Record<string, string>
    paneBindings: Record<string, string>
  } = {
    savedRows: [persistedOwner.logicalPtyId],
    tabBindings: { 'tab-1': persistedOwner.logicalPtyId },
    paneBindings: { 'tab-1:leaf-1': persistedOwner.logicalPtyId }
  }
  const liveMarkerIo = ['agent-a-still-running']
  let freshShells = 0

  const verdict = await resolver.probe(
    persistedOwner.logicalPtyId,
    persistedOwner.sessionIncarnationId
  )
  if (verdict === false) {
    topology.savedRows = []
    topology.tabBindings = {}
    topology.paneBindings = {}
    freshShells += 1
  }

  expect(verdict).toBeNull()
  expect(replacementB.probePtyLiveness).not.toHaveBeenCalled()
  expect(replacementB.listProcesses).not.toHaveBeenCalled()
  expect(topology).toEqual({
    savedRows: ['logical-pty'],
    tabBindings: { 'tab-1': 'logical-pty' },
    paneBindings: { 'tab-1:leaf-1': 'logical-pty' }
  })
  expect(liveMarkerIo).toHaveLength(1)
  expect(freshShells).toBe(0)
})
