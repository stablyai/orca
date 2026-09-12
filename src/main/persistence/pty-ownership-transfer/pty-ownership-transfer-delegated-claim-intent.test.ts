import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PtyOwnershipTransferDestinationFileStore } from './pty-ownership-transfer-destination-file-store'
import { parsePtyOwnershipTransferDestinationFile } from './pty-ownership-transfer-destination-file'
import {
  identity,
  preparation,
  request
} from '../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import * as durableWrite from '../../durable-file-write'

describe('durable delegated claim intent', () => {
  let directory: string
  let store: PtyOwnershipTransferDestinationFileStore
  const source = {
    version: 1,
    proof: { ...identity, version: 1, credential: request().credential },
    endpoint: '/host/incumbent.sock',
    incumbentVersion: 'incumbent-build',
    endpointCredential: 'endpoint-secret'
  }
  const first = {
    version: 1,
    previousClaim: null,
    claim: { generation: 1, claimId: 'claim-1' }
  }
  const second = {
    version: 1,
    previousClaim: first.claim,
    claim: { generation: 2, claimId: 'claim-2' }
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-delegated-claim-intent-'))
    store = new PtyOwnershipTransferDestinationFileStore({ directory })
    store.prepare(identity, 0)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })
  const disk = () => JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), 'utf8'))
  const reserveFirst = () => {
    store.bindDelegatedSource(identity, source)
    return store.reserveDelegatedClaimIntent(identity, null, first)
  }

  it('requires a bound source, exact identity, and a non-aborted record', () => {
    expect(store.loadDelegatedClaimIntent(identity)).toBeNull()
    expect(() => store.reserveDelegatedClaimIntent(identity, null, first)).toThrow()
    store.bindDelegatedSource(identity, source)
    expect(() =>
      store.reserveDelegatedClaimIntent({ ...identity, terminalId: 'other' }, null, first)
    ).toThrow()
    store.abort(identity)
    expect(() => store.reserveDelegatedClaimIntent(identity, null, first)).toThrow()
    expect(store.loadDelegatedClaimIntent(identity)).toBeNull()
  })

  it('persists an exact initial reservation and successor through restart', () => {
    expect(reserveFirst()).toEqual(first)
    expect(disk().version).toBe(3)
    const restored = new PtyOwnershipTransferDestinationFileStore({ directory })
    expect(restored.loadDelegatedClaimIntent(identity)).toEqual(first)
    expect(restored.reserveDelegatedClaimIntent(identity, first, second)).toEqual(second)
    expect(store.loadDelegatedClaimIntent(identity)).toEqual(second)
    expect(store.loadDelegatedSource(identity)).toEqual(source)
  })

  it('makes exact reservation retries idempotent even with a stale expected intent', () => {
    reserveFirst()
    store.reserveDelegatedClaimIntent(identity, first, second)
    const save = vi.spyOn(durableWrite, 'writeFileDurableSync')
    expect(store.reserveDelegatedClaimIntent(identity, null, second)).toEqual(second)
    expect(store.reserveDelegatedClaimIntent(identity, first, second)).toEqual(second)
    expect(save).not.toHaveBeenCalled()
  })

  it('rejects competing, stale and partially matching compare-and-swap reservations', () => {
    reserveFirst()
    const competing = { ...second, claim: { generation: 2, claimId: 'competitor' } }
    const save = vi.spyOn(durableWrite, 'writeFileDurableSync')
    expect(() => store.reserveDelegatedClaimIntent(identity, null, second)).toThrow()
    expect(() =>
      store.reserveDelegatedClaimIntent(
        identity,
        { ...first, claim: { generation: 1, claimId: 'different' } },
        second
      )
    ).toThrow()
    expect(save).not.toHaveBeenCalled()
    store.reserveDelegatedClaimIntent(identity, first, second)
    expect(() => store.reserveDelegatedClaimIntent(identity, first, competing)).toThrow()
    expect(() =>
      store.reserveDelegatedClaimIntent(
        identity,
        { ...second, previousClaim: { generation: 1, claimId: 'foreign' } },
        { version: 1, previousClaim: second.claim, claim: { generation: 3, claimId: 'third' } }
      )
    ).toThrow()
    expect(store.loadDelegatedClaimIntent(identity)).toEqual(second)
  })

  it.each([
    { ...first, version: 2 },
    { ...first, previousClaim: undefined },
    { ...first, claim: { generation: 0, claimId: 'zero' } },
    { ...first, claim: { generation: 2, claimId: 'skipped' } },
    { ...first, claim: { generation: 1, claimId: '' } },
    { ...first, claim: { generation: 1, claimId: 'x'.repeat(129) } },
    { ...first, claim: { generation: 1.5, claimId: 'fractional' } },
    second
  ])('rejects invalid initial reservations without writing: %j', (invalid) => {
    store.bindDelegatedSource(identity, source)
    const save = vi.spyOn(durableWrite, 'writeFileDurableSync')
    expect(() => store.reserveDelegatedClaimIntent(identity, null, invalid)).toThrow()
    expect(save).not.toHaveBeenCalled()
    expect(store.loadDelegatedClaimIntent(identity)).toBeNull()
  })

  it.each([
    { ...second, previousClaim: { generation: 1, claimId: 'foreign' } },
    { ...second, previousClaim: null },
    { ...second, claim: { generation: 2, claimId: first.claim.claimId } },
    { ...second, claim: { generation: 3, claimId: 'skipped' } },
    {
      ...second,
      previousClaim: { generation: Number.MAX_SAFE_INTEGER, claimId: 'overflow' },
      claim: { generation: Number.MAX_SAFE_INTEGER + 1, claimId: 'overflow-next' }
    }
  ])('rejects invalid successors without replacing the current intent: %j', (invalid) => {
    reserveFirst()
    const save = vi.spyOn(durableWrite, 'writeFileDurableSync')
    expect(() => store.reserveDelegatedClaimIntent(identity, first, invalid)).toThrow()
    expect(save).not.toHaveBeenCalled()
    expect(store.loadDelegatedClaimIntent(identity)).toEqual(first)
  })

  it('returns defensive snapshots and does not retain mutable reservation input', () => {
    store.bindDelegatedSource(identity, source)
    const supplied = structuredClone(first)
    const reserved = store.reserveDelegatedClaimIntent(identity, null, supplied)
    supplied.claim.claimId = 'mutated-input'
    expect(reserved).toEqual(first)
    const loaded = store.loadDelegatedClaimIntent(identity)
    expect(loaded).toEqual(first)
    expect(loaded).not.toBe(reserved)
    expect(loaded?.claim).not.toBe(reserved.claim)
    expect(store.loadDelegatedClaimIntent(identity)).toEqual(first)
  })

  it('requires v3 intent and source fields and rejects downgraded intent records', () => {
    reserveFirst()
    const record = disk()
    expect(parsePtyOwnershipTransferDestinationFile(record, 10).version).toBe(3)
    for (const invalid of [
      { ...record, version: 1 },
      { ...record, version: 2 },
      { ...record, delegatedSource: undefined },
      { ...record, delegatedClaimIntent: undefined },
      { ...record, delegatedClaimIntent: { ...first, claim: { generation: 0, claimId: 'x' } } }
    ]) {
      expect(() => parsePtyOwnershipTransferDestinationFile(invalid, 10)).toThrow()
    }
    expect(disk()).toEqual(record)
  })

  it('preserves intent across replay, commit, surface binding, and publication', () => {
    reserveFirst()
    store.appendFrame(identity, { seq: 1, data: 'retained' })
    const receipt = {
      bridgeId: identity.bridgeId,
      receiptId: 'receipt',
      acceptedSourceEndSeq: 1,
      committedAt: '2026-09-06T00:00:00.000Z'
    }
    store.commit(identity, receipt)
    store.bindSurface(identity, preparation.surfacePublication.surfaceBinding)
    store.publish(identity, store.reservePublication(identity, receipt))
    const restored = new PtyOwnershipTransferDestinationFileStore({ directory })
    expect(restored.load(identity)?.phase).toBe('published')
    expect(restored.loadDelegatedClaimIntent(identity)).toEqual(first)
    expect(restored.loadDelegatedSource(identity)).toEqual(source)
    expect(restored.loadFrames(identity)).toEqual([{ seq: 1, data: 'retained' }])
  })

  it('retains intent when aborting but refuses even an identical reservation retry', () => {
    reserveFirst()
    store.abort(identity)
    expect(store.loadDelegatedClaimIntent(identity)).toEqual(first)
    expect(() => store.reserveDelegatedClaimIntent(identity, null, first)).toThrow()
    expect(() => store.reserveDelegatedClaimIntent(identity, first, second)).toThrow()
  })

  it.each([false, true])(
    'reconciles an uncertain successor save from disk (written=%s)',
    (written) => {
      reserveFirst()
      const write = durableWrite.writeFileDurableSync
      vi.spyOn(durableWrite, 'writeFileDurableSync').mockImplementation((...args) => {
        if (written) {
          write(...args)
        }
        throw new Error('uncertain claim intent save')
      })
      expect(() => store.reserveDelegatedClaimIntent(identity, first, second)).toThrow(
        'uncertain claim intent save'
      )
      vi.restoreAllMocks()
      const restored = new PtyOwnershipTransferDestinationFileStore({ directory })
      expect(restored.loadDelegatedClaimIntent(identity)).toEqual(written ? second : first)
      expect(restored.reserveDelegatedClaimIntent(identity, first, second)).toEqual(second)
      expect(restored.loadDelegatedClaimIntent(identity)).toEqual(second)
    }
  )
})
