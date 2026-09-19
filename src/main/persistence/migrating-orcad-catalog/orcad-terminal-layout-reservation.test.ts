import { describe, expect, it } from 'vitest'
import { terminalLayoutAdmissionFixture } from './orcad-terminal-layout-admission-test-fixture'
import { resolveOrcadTerminalLayoutReservation } from './orcad-terminal-layout-reservation'

function fixture(kind: 'folder' | 'worktree' = 'worktree') {
  const f = terminalLayoutAdmissionFixture(kind)
  const { identity, surfaceBinding } = f.bindings[0]
  const receipt = {
    bridgeId: identity.bridgeId,
    receiptId: 'receipt',
    acceptedSourceEndSeq: 0,
    committedAt: '2026-09-06T00:00:00.000Z'
  }
  const publicationReceipt = {
    version: 1 as const,
    publicationReceiptId: 'publication',
    bridgeId: identity.bridgeId,
    destinationRuntimeId: identity.destinationRuntimeId,
    commitReceipt: receipt,
    publishedAt: receipt.committedAt,
    surfaceBinding
  }
  const record = {
    version: 5,
    catalogAdmission: f.admission,
    delegatedSource: {
      version: 1,
      proof: { ...identity, version: 1, credential: 'a'.repeat(64) },
      endpoint: '/source.sock',
      incumbentVersion: 'test',
      endpointCredential: 'test'
    },
    journal: {
      ...identity,
      version: 1,
      side: 'destination',
      phase: 'committed',
      acceptedSourceEndSeq: 0,
      startedAt: receipt.committedAt,
      updatedAt: receipt.committedAt,
      receipt
    },
    surfaceBinding,
    publicationIntent: publicationReceipt,
    frames: [],
    inputIds: []
  }
  return { ...f, record, request: { identity, surfaceBinding, publicationReceipt } }
}

describe('durable terminal layout reservation resolution', () => {
  it.each(['folder', 'worktree'] as const)(
    'derives exact %s topology from committed intent before published phase',
    (kind) => {
      const f = fixture(kind)
      const result = resolveOrcadTerminalLayoutReservation(f.record, f.request)!
      expect(result.worktreeId).toBe(f.owner)
      expect(result.layout).toEqual(
        f.manifest.payload.dormantState!.workspaceSession!.terminalLayoutsByTabId['tab-1']
      )
      expect(result.bindings).toHaveLength(2)
      expect(result.tab.ptyId).toBeNull()
      result.tab.title = 'mutated'
      expect(resolveOrcadTerminalLayoutReservation(f.record, f.request)!.tab.title).toBe(
        'Preserved tab'
      )
    }
  )

  it('does not accept a different identity, surface or receipt', () => {
    const f = fixture()
    for (const request of [
      { ...f.request, identity: { ...f.request.identity, incarnationId: 'other' } },
      { ...f.request, surfaceBinding: { ...f.request.surfaceBinding, tabId: 'other' } },
      {
        ...f.request,
        publicationReceipt: { ...f.request.publicationReceipt, publicationReceiptId: 'other' }
      }
    ]) {
      expect(() => resolveOrcadTerminalLayoutReservation(f.record, request)).toThrow()
    }
  })

  it('retains reservation derivation after published phase without a staging-store dependency', () => {
    const f = fixture()
    expect(
      resolveOrcadTerminalLayoutReservation(
        {
          ...f.record,
          journal: {
            ...f.record.journal,
            phase: 'published',
            publicationReceipt: f.request.publicationReceipt
          }
        },
        f.request
      )
    ).toEqual(resolveOrcadTerminalLayoutReservation(f.record, f.request))
  })

  it('refuses absent publication intent and malformed durable evidence', () => {
    const f = fixture()
    expect(() =>
      resolveOrcadTerminalLayoutReservation(
        { ...f.record, publicationIntent: undefined },
        f.request
      )
    ).toThrow('orcad_terminal_layout_reservation_publication_conflict')
    expect(() =>
      resolveOrcadTerminalLayoutReservation({ ...f.record, version: 999 }, f.request)
    ).toThrow()
    expect(() =>
      resolveOrcadTerminalLayoutReservation({ ...f.record, catalogAdmission: undefined }, f.request)
    ).toThrow()
  })

  it('keeps older non-catalog journal behavior distinct', () => {
    const f = fixture()
    expect(
      resolveOrcadTerminalLayoutReservation(
        { ...f.record, version: 2, catalogAdmission: undefined },
        f.request
      )
    ).toBeNull()
  })
})
