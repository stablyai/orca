import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  terminalLayoutAdmissionFixture,
  sealAdmissionManifest
} from '../migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import { PtyOwnershipTransferDestinationFileStore } from './pty-ownership-transfer-destination-file-store'
import { parsePtyOwnershipTransferDestinationFile } from './pty-ownership-transfer-destination-file'
import * as durable from '../../durable-file-write'

let directory: string
const reopen = () => new PtyOwnershipTransferDestinationFileStore({ directory })
const disk = () =>
  JSON.parse(
    readFileSync(
      join(
        directory,
        readdirSync(directory).find((name) => name.endsWith('.json'))!
      ),
      'utf8'
    )
  )

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-catalog-admission-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

function setup() {
  const { admission } = terminalLayoutAdmissionFixture()
  const { identity } = admission.bindings[0]
  const store = reopen()
  store.prepare(identity, 0)
  store.bindDelegatedSource(identity, {
    version: 1,
    proof: { ...identity, version: 1, credential: 'a'.repeat(64) },
    endpoint: '/source.sock',
    incumbentVersion: 'test',
    endpointCredential: 'test'
  })
  return { store, admission, identity }
}

describe('durable catalog-bound transfer admission', () => {
  it('retains the exact manifest and all split bindings across restart and retry', () => {
    const { store, admission, identity } = setup()
    store.surface.bindCatalogAdmission(identity, admission)
    expect(disk().version).toBe(5)
    expect(reopen().surface.loadCatalogAdmission(identity)).toEqual(admission)
    expect(reopen().loadSurfaceBinding(identity)).toEqual(admission.bindings[0].surfaceBinding)
    const write = vi.spyOn(durable, 'writeFileDurableSync')
    reopen().surface.bindCatalogAdmission(identity, structuredClone(admission))
    expect(write).not.toHaveBeenCalled()
    const loaded = reopen().surface.loadCatalogAdmission(identity)!
    loaded.manifest.payload.repositories[0].path = '/mutated-copy'
    expect(reopen().surface.loadCatalogAdmission(identity)).toEqual(admission)
  })

  it('rejects transaction replacement and source identity drift without changing durable evidence', () => {
    const { store, admission, identity } = setup()
    store.surface.bindCatalogAdmission(identity, admission)
    const other = {
      ...admission,
      manifest: sealAdmissionManifest({ ...admission.manifest, migrationId: 'other' })
    }
    expect(() => store.surface.bindCatalogAdmission(identity, other)).toThrow(
      'pty_ownership_transfer_destination_catalog_conflict'
    )
    expect(() =>
      store.surface.bindCatalogAdmission(identity, {
        ...admission,
        bindings: admission.bindings.slice(1)
      })
    ).toThrow('pty_ownership_transfer_destination_catalog_identity_invalid')
    expect(reopen().surface.loadCatalogAdmission(identity)).toEqual(admission)
  })

  it('leaves no acknowledged admission after a failed durable write', () => {
    const { store, admission, identity } = setup()
    vi.spyOn(durable, 'writeFileDurableSync').mockImplementationOnce(() => {
      throw new Error('disk failed')
    })
    expect(() => store.surface.bindCatalogAdmission(identity, admission)).toThrow('disk failed')
    expect(reopen().surface.loadCatalogAdmission(identity)).toBeNull()
    store.surface.bindCatalogAdmission(identity, admission)
    expect(reopen().surface.loadCatalogAdmission(identity)).toEqual(admission)
  })

  it('refuses stripping the newer format marker or its admission evidence', () => {
    const { store, admission, identity } = setup()
    store.surface.bindCatalogAdmission(identity, admission)
    const record = disk()
    for (const version of [1, 2, 3, 4]) {
      expect(() => parsePtyOwnershipTransferDestinationFile({ ...record, version }, 10)).toThrow()
    }
    expect(() =>
      parsePtyOwnershipTransferDestinationFile({ ...record, catalogAdmission: undefined }, 10)
    ).toThrow()
    expect(() =>
      parsePtyOwnershipTransferDestinationFile(
        {
          ...record,
          journal: { ...record.journal, incarnationId: 'changed' },
          delegatedSource: {
            ...record.delegatedSource,
            proof: { ...record.delegatedSource.proof, incarnationId: 'changed' }
          }
        },
        10
      )
    ).toThrow('pty_ownership_transfer_destination_catalog_identity_invalid')
  })

  it('retains v5 admission through claim and input state transitions; publication remains fenced', () => {
    const { store, admission, identity } = setup()
    store.surface.bindCatalogAdmission(identity, admission)
    const claim = { version: 1, previousClaim: null, claim: { generation: 1, claimId: 'claim' } }
    store.reserveDelegatedClaimIntent(identity, null, claim)
    const receipt = {
      bridgeId: identity.bridgeId,
      receiptId: 'receipt',
      acceptedSourceEndSeq: 0,
      committedAt: '2026-09-06T00:00:00.000Z'
    }
    store.commit(identity, receipt)
    store.input.transitionDelegated(identity, {
      kind: 'attempt',
      epoch: 0,
      inputId: 'input',
      data: 'command'
    })
    expect(disk().version).toBe(5)
    expect(reopen().surface.loadCatalogAdmission(identity)).toEqual(admission)
    expect(reopen().input.loadDelegated(identity)?.entries[0].phase).toBe('attempted')
    expect(() => store.reservePublication(identity, receipt)).toThrow(
      'pty_ownership_transfer_catalog_publication_not_supported'
    )
  })

  it('keeps admission evidence in an aborted journal', () => {
    const { store, admission, identity } = setup()
    store.surface.bindCatalogAdmission(identity, admission)
    store.abort(identity)
    expect(reopen().load(identity)?.phase).toBe('aborted')
    expect(reopen().surface.loadCatalogAdmission(identity)).toEqual(admission)
    expect(reopen().loadSurfaceBinding(identity)).toBeNull()
  })
})
