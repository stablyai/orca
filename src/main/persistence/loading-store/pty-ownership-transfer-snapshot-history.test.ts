import * as fs from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { terminalLayoutAdmissionFixture } from '../migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import {
  ownershipTransferSurfaceSnapshotRef,
  ownershipTransferSurfaceModelSnapshotRef
} from '../pty-ownership-transfer/pty-ownership-transfer-snapshot-reference'
import { ptyOwnershipTransferDestinationDirectory } from '../pty-ownership-transfer/pty-ownership-transfer-destination-file-store-contract'
import { PtyOwnershipTransferSnapshotHistory } from './pty-ownership-transfer-snapshot-history'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) }
})

let directory: string
beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), 'orca-history-index-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const { admission, owner } = terminalLayoutAdmissionFixture()
  const { identity, surfaceBinding } = admission.bindings[0]
  const publicationReceipt = {
    version: 1 as const,
    publicationReceiptId: 'publication-1',
    bridgeId: identity.bridgeId,
    destinationRuntimeId: identity.destinationRuntimeId,
    surfaceBinding,
    publishedAt: '2026-09-06T00:00:00.000Z',
    commitReceipt: {
      bridgeId: identity.bridgeId,
      receiptId: 'commit-1',
      acceptedSourceEndSeq: 0,
      committedAt: '2026-09-06T00:00:00.000Z'
    }
  }
  const evidence = { identity, surfaceBinding, publicationReceipt }
  const ref = ownershipTransferSurfaceSnapshotRef(evidence)
  const modelRef = ownershipTransferSurfaceModelSnapshotRef(evidence)
  const session = structuredClone(admission.manifest.payload.dormantState!.workspaceSession!)
  const layout = session.terminalLayoutsByTabId[surfaceBinding.tabId]
  session.tabsByWorktree[owner][0].ptyId = identity.terminalId
  layout.ptyIdsByLeafId = { [surfaceBinding.leafId]: identity.terminalId }
  layout.scrollbackRefsByLeafId = { [surfaceBinding.leafId]: ref }
  layout.buffersByLeafId = { [surfaceBinding.leafId]: 'renderer bytes' }
  session.terminalPtyIncarnationsByPaneKey = {
    [`${surfaceBinding.tabId}:${surfaceBinding.leafId}`]: identity.incarnationId
  }
  const repos = admission.manifest.payload.repositories
  return { evidence, ref, modelRef, session, repos, binding: surfaceBinding }
}

describe('transfer snapshot history ownership', () => {
  it('keeps ordinary local pruning unchanged until publication evidence exists', () => {
    const { session, repos, binding, evidence, ref } = fixture()
    const history = new PtyOwnershipTransferSnapshotHistory(directory)
    expect(
      history.prune(session, repos).terminalLayoutsByTabId[binding.tabId].scrollbackRefsByLeafId
    ).toBeUndefined()
    history.recordPublication(evidence)
    const next = history.prune(session, repos)
    expect(next.terminalLayoutsByTabId[binding.tabId].scrollbackRefsByLeafId).toEqual({
      [binding.leafId]: ref
    })
    expect(next.terminalLayoutsByTabId[binding.tabId].buffersByLeafId).toBeUndefined()
  })

  it('does not rescan journals for session saves or newly registered publication', () => {
    const { session, repos, evidence } = fixture()
    const read = vi.mocked(fs.readdirSync).mockClear()
    const history = new PtyOwnershipTransferSnapshotHistory(directory)
    history.prune(session, repos)
    expect(read).toHaveBeenCalledTimes(1)
    history.recordPublication(evidence)
    history.prune(session, repos)
    history.prune(session, repos)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('refuses changing an indexed publication without losing the original history', () => {
    const { session, repos, evidence, ref, binding } = fixture()
    const history = new PtyOwnershipTransferSnapshotHistory(directory)
    history.recordPublication(evidence)
    expect(() =>
      history.recordPublication({
        ...evidence,
        publicationReceipt: { ...evidence.publicationReceipt, publicationReceiptId: 'different' }
      })
    ).toThrow('pty_ownership_transfer_history_evidence_conflict')
    expect(
      history.prune(session, repos).terminalLayoutsByTabId[binding.tabId].scrollbackRefsByLeafId
    ).toEqual({ [binding.leafId]: ref })
  })

  it('keeps a host model checkpoint when an older renderer sends the baseline or omits refs', () => {
    const { session, repos, evidence, binding, modelRef } = fixture()
    const history = new PtyOwnershipTransferSnapshotHistory(directory)
    history.recordPublication(evidence)
    const prior = structuredClone(session)
    prior.terminalLayoutsByTabId[binding.tabId].scrollbackRefsByLeafId = {
      [binding.leafId]: modelRef
    }
    for (const omit of [false, true]) {
      const next = structuredClone(session)
      if (omit) {
        delete next.terminalLayoutsByTabId[binding.tabId].scrollbackRefsByLeafId
      }
      expect(
        history.prune(next, repos, prior).terminalLayoutsByTabId[binding.tabId]
          .scrollbackRefsByLeafId
      ).toEqual({ [binding.leafId]: modelRef })
    }
  })

  it('retains existing refs when journal authority is unreadable, without claiming ownership', () => {
    const { session, repos, binding, ref } = fixture()
    const path = join(ptyOwnershipTransferDestinationDirectory(directory), `${'a'.repeat(64)}.json`)
    fs.mkdirSync(dirname(path), { recursive: true })
    fs.writeFileSync(path, '{}')
    const history = new PtyOwnershipTransferSnapshotHistory(directory)
    expect(
      history.prune(session, repos).terminalLayoutsByTabId[binding.tabId].scrollbackRefsByLeafId
    ).toEqual({ [binding.leafId]: ref })
    const replacement = structuredClone(session)
    delete replacement.terminalLayoutsByTabId[binding.tabId].scrollbackRefsByLeafId
    replacement.terminalPtyIncarnationsByPaneKey![`${binding.tabId}:${binding.leafId}`] =
      'replacement'
    expect(
      history.prune(replacement, repos, session).terminalLayoutsByTabId[binding.tabId]
        .scrollbackRefsByLeafId
    ).toBeUndefined()
  })

  it('never restores a removed leaf or a closed tab from a previous session', () => {
    const { session, repos, binding, evidence } = fixture()
    const history = new PtyOwnershipTransferSnapshotHistory(directory)
    history.recordPublication(evidence)
    const next = structuredClone(session)
    next.terminalLayoutsByTabId[binding.tabId].root = null
    delete next.terminalLayoutsByTabId[binding.tabId].scrollbackRefsByLeafId
    expect(
      history.prune(next, repos, session).terminalLayoutsByTabId[binding.tabId]
        .scrollbackRefsByLeafId
    ).toBeUndefined()
    delete next.terminalLayoutsByTabId[binding.tabId]
    expect(
      history.prune(next, repos, session).terminalLayoutsByTabId[binding.tabId]
    ).toBeUndefined()
  })
})
