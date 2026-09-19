import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { terminalLayoutAdmissionFixture } from '../migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import { PtyOwnershipTransferDestinationFileStore } from './pty-ownership-transfer-destination-file-store'
import { bindCapturedPtyCatalogAdmission } from './pty-ownership-transfer-captured-catalog-admission'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-captured-catalog-'))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
function fixture() {
  const { admission } = terminalLayoutAdmissionFixture()
  const { identity, surfaceBinding } = admission.bindings[0]
  const destinationStore = new PtyOwnershipTransferDestinationFileStore({ directory })
  const args = {
    value: admission,
    result: {
      ...identity,
      version: 1 as const,
      phase: 'prepared' as const,
      sourceOutputEndSeq: 3,
      replayStartSeq: 4,
      surfacePublication: { version: 1 as const, surfaceBinding }
    },
    source: {
      version: 1,
      proof: { ...identity, version: 1, credential: 'a'.repeat(64) },
      endpoint: '/source.sock',
      incumbentVersion: 'test',
      endpointCredential: 'test'
    },
    destinationStore,
    prepareCatalog: vi.fn(() => admission),
    assertActive: vi.fn()
  }
  return { args, identity, admission }
}

it('flushes host admission before creating the durable prepared destination and retries exactly', () => {
  const f = fixture()
  f.args.prepareCatalog.mockImplementation(() => {
    expect(f.args.destinationStore.load(f.identity)).toBeNull()
    return f.admission
  })
  bindCapturedPtyCatalogAdmission(f.args)
  const reopened = new PtyOwnershipTransferDestinationFileStore({ directory })
  expect(reopened.surface.loadCatalogAdmission(f.identity)).toEqual(f.admission)
  expect(reopened.load(f.identity)).toMatchObject({ phase: 'prepared', acceptedSourceEndSeq: 3 })
  f.args.prepareCatalog.mockReturnValue(f.admission)
  bindCapturedPtyCatalogAdmission(f.args)
  expect(reopened.surface.loadCatalogAdmission(f.identity)).toEqual(f.admission)
})

it.each(['flush', 'lifecycle', 'source-surface', 'source-identity'])(
  'refuses %s failure before creating destination evidence',
  (kind) => {
    const f = fixture()
    if (kind === 'flush') {
      f.args.prepareCatalog.mockImplementation(() => {
        throw new Error('disk failed')
      })
    }
    if (kind === 'lifecycle') {
      f.args.assertActive
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw new Error('closed')
        })
    }
    if (kind === 'source-surface') {
      f.args.result.surfacePublication.surfaceBinding = {
        ...f.args.result.surfacePublication.surfaceBinding,
        tabId: 'other'
      }
    }
    if (kind === 'source-identity') {
      f.args.result.incarnationId = 'other'
    }
    expect(() => bindCapturedPtyCatalogAdmission(f.args)).toThrow()
    expect(f.args.destinationStore.load(f.identity)).toBeNull()
    if (kind.startsWith('source-')) {
      expect(f.args.prepareCatalog).not.toHaveBeenCalled()
    }
  }
)
