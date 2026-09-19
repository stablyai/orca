import { expect, it } from 'vitest'
import {
  terminalLayoutAdmissionFixture,
  sealAdmissionManifest
} from '../migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import { assertCapturedPtyRetryCatalog } from './pty-ownership-transfer-captured-publication-retry'

it('accepts legacy omission only when durable admission is also absent', () => {
  expect(() => assertCapturedPtyRetryCatalog(undefined, null)).not.toThrow()
  const { admission } = terminalLayoutAdmissionFixture()
  expect(() => assertCapturedPtyRetryCatalog(undefined, admission)).toThrow(
    'retry_catalog_conflict'
  )
  expect(() => assertCapturedPtyRetryCatalog(admission, null)).toThrow('retry_catalog_conflict')
})

it('accepts exact catalog retry without changing either copy', () => {
  const { admission } = terminalLayoutAdmissionFixture()
  const proposed = structuredClone(admission)
  expect(() => assertCapturedPtyRetryCatalog(proposed, admission)).not.toThrow()
  expect(proposed).toEqual(admission)
})

it.each(['manifest', 'bindings', 'malformed'])('refuses %s drift in catalog retry', (kind) => {
  const { admission } = terminalLayoutAdmissionFixture()
  const proposed =
    kind === 'manifest'
      ? {
          ...admission,
          manifest: sealAdmissionManifest({ ...admission.manifest, migrationId: 'other' })
        }
      : kind === 'bindings'
        ? { ...admission, bindings: admission.bindings.slice(0, 1) }
        : { ...admission, version: 999 }
  expect(() => assertCapturedPtyRetryCatalog(proposed, admission)).toThrow()
})
