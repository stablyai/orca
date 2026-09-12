import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catalogActivationFixture } from './orcad-catalog-activation-test-fixture'
import { createOrcadModelImportFixture } from '../orcad/orcad-model-import-test-fixture'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'
import { bindOrcadLiveRetirementCapture } from './orcad-live-retirement-capture'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-retirement-capture-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const { request } = catalogActivationFixture()
  const source = createOrcadModelImportFixture(root)
  const record = {
    version: 2,
    destinationEnvironmentId: 'environment',
    sourceSshTargetId: request.catalogAdmission.manifest.source.sshTargetId,
    sourceSshTargetGeneration: request.catalogAdmission.manifest.source.sshTargetGeneration,
    identity: request.identity,
    catalogAdmission: request.catalogAdmission,
    source: source.store.loadDelegatedSource(request.identity),
    selection: source.selection,
    model: source.model,
    surfaceBinding: request.publicationReceipt.surfaceBinding
  }
  const store = new OrcadOutgoingCaptureStore(root)
  store.persist(record)
  const controller = new AbortController()
  const options = {
    profileDirectory: root,
    identity: request.identity,
    catalogAdmission: request.catalogAdmission,
    destinationEnvironmentId: 'environment',
    signal: controller.signal,
    assertAuthority: vi.fn()
  }
  return { options, record, controller, store, run: () => bindOrcadLiveRetirementCapture(options) }
}

it('binds exact durable capture without exposing the mutable reference used for comparison', () => {
  const f = fixture()
  const bound = f.run()
  expect(bound.capture).toEqual(f.store.read(f.record.identity))
  bound.capture.model.modelData = 'changed returned copy'
  expect(bound.assertCurrent).not.toThrow()
})

it.each(['environment', 'catalog', 'identity', 'missing'] as const)(
  'refuses %s mismatch',
  (kind) => {
    const f = fixture()
    if (kind === 'environment') {
      f.options.destinationEnvironmentId = 'other'
    }
    if (kind === 'catalog') {
      f.options.catalogAdmission = null as never
    }
    if (kind === 'identity') {
      f.options.identity = { ...f.options.identity, ownerLease: 'other' }
    }
    if (kind === 'missing') {
      f.options.profileDirectory = join(root, 'absent')
    }
    expect(f.run).toThrow()
  }
)

it.each(['record', 'aborted', 'authority'] as const)(
  'rechecks %s before later retirement operations',
  (kind) => {
    const f = fixture()
    const bound = f.run()
    if (kind === 'record') {
      vi.spyOn(OrcadOutgoingCaptureStore.prototype, 'read').mockReturnValue(null)
    }
    if (kind === 'aborted') {
      f.controller.abort()
    }
    if (kind === 'authority') {
      f.options.assertAuthority.mockImplementation(() => {
        throw new Error('authority lost')
      })
    }
    expect(bound.assertCurrent).toThrow()
  }
)
