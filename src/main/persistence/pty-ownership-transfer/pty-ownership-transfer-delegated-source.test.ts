import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PtyOwnershipTransferDestinationFileStore } from './pty-ownership-transfer-destination-file-store'
import { parsePtyOwnershipTransferDestinationFile } from './pty-ownership-transfer-destination-file'
import {
  identity,
  request
} from '../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import * as durableWrite from '../../durable-file-write'

describe('durable delegated source binding', () => {
  let directory: string
  let store: PtyOwnershipTransferDestinationFileStore
  const source = {
    version: 1,
    proof: { ...identity, version: 1, credential: request().credential },
    endpoint: '/host/incumbent.sock',
    incumbentVersion: 'incumbent-build',
    endpointCredential: 'endpoint-secret'
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-delegated-binding-'))
    store = new PtyOwnershipTransferDestinationFileStore({ directory })
    store.prepare(identity, 0)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })
  const disk = () => JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), 'utf8'))

  it('keeps exact credentials with replay and commit through restart without listing secrets', () => {
    store.bindDelegatedSource(identity, source)
    store.appendFrame(identity, { seq: 1, data: 'retained' })
    const receipt = {
      bridgeId: identity.bridgeId,
      receiptId: 'receipt',
      acceptedSourceEndSeq: 1,
      committedAt: '2026-09-06T00:00:00.000Z'
    }
    store.commit(identity, receipt)
    const restored = new PtyOwnershipTransferDestinationFileStore({ directory })
    expect(restored.loadDelegatedSource(identity)).toMatchObject(source)
    expect(restored.load(identity)?.receipt).toEqual(receipt)
    expect(restored.loadFrames(identity)).toEqual([{ seq: 1, data: 'retained' }])
    const candidates = JSON.stringify(restored.listRecoveryCandidates())
    expect(restored.listRecoveryCandidates()[0].requiresDelegatedSource).toBe(true)
    expect(candidates).not.toContain(source.endpointCredential)
    expect(candidates).not.toContain(source.proof.credential)
    expect(disk().version).toBe(2)
    if (process.platform !== 'win32') {
      expect(statSync(join(directory, readdirSync(directory)[0])).mode & 0o777).toBe(0o600)
    }
  })

  it('allows exact rebinding only, without rewriting or replacing credentials', () => {
    store.bindDelegatedSource(identity, source)
    const save = vi.spyOn(durableWrite, 'writeFileDurableSync')
    store.bindDelegatedSource(identity, source)
    expect(save).not.toHaveBeenCalled()
    for (const patch of [
      { endpoint: '/different.sock' },
      { endpointCredential: 'other' },
      { proof: { ...source.proof, credential: 'a'.repeat(64) } }
    ]) {
      expect(() => store.bindDelegatedSource(identity, { ...source, ...patch })).toThrow(
        'source_conflict'
      )
    }
    expect(save).not.toHaveBeenCalled()
  })

  it('rejects downgraded, missing and mismatched capability records', () => {
    const legacy = disk()
    expect(() =>
      parsePtyOwnershipTransferDestinationFile({ ...legacy, delegatedSource: source }, 10)
    ).toThrow()
    expect(() => parsePtyOwnershipTransferDestinationFile({ ...legacy, version: 2 }, 10)).toThrow()
    expect(() =>
      store.bindDelegatedSource(identity, {
        ...source,
        proof: { ...source.proof, terminalId: 'different' }
      })
    ).toThrow('identity_invalid')
    expect(disk()).toEqual(legacy)
  })

  it.each([false, true])(
    'reconciles a failed binding save from durable state (written=%s)',
    (written) => {
      const write = durableWrite.writeFileDurableSync
      vi.spyOn(durableWrite, 'writeFileDurableSync').mockImplementation((...args) => {
        if (written) {
          write(...args)
        }
        throw new Error('uncertain binding save')
      })
      expect(() => store.bindDelegatedSource(identity, source)).toThrow('uncertain binding save')
      vi.restoreAllMocks()
      const restored = new PtyOwnershipTransferDestinationFileStore({ directory })
      expect(restored.loadDelegatedSource(identity) !== null).toBe(written)
      restored.bindDelegatedSource(identity, source)
      expect(restored.loadDelegatedSource(identity)).toMatchObject(source)
    }
  )
})
