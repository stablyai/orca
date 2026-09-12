import { describe, expect, it } from 'vitest'
import {
  parseOrcadTerminalLayoutAdmission,
  prepareOrcadTerminalLayoutAdmission
} from './orcad-terminal-layout-admission'
import { terminalLayoutAdmissionFixture } from './orcad-terminal-layout-admission-test-fixture'

describe('catalog-bound terminal layout admission', () => {
  it.each(['folder', 'worktree'] as const)(
    'preserves a staged %s split exactly without mutation',
    (kind) => {
      const fixture = terminalLayoutAdmissionFixture(kind)
      const before = structuredClone(fixture)
      expect(
        prepareOrcadTerminalLayoutAdmission(fixture.manifest, fixture.bindings, fixture.state)
      ).toEqual(fixture.admission)
      expect(
        parseOrcadTerminalLayoutAdmission(JSON.parse(JSON.stringify(fixture.admission)))
      ).toEqual(fixture.admission)
      expect(fixture).toEqual(before)
    }
  )

  it('requires the exact staged transaction', () => {
    const { manifest, bindings, state } = terminalLayoutAdmissionFixture()
    state.orcadMigrationStagedCatalogs = []
    expect(() => prepareOrcadTerminalLayoutAdmission(manifest, bindings, state)).toThrow(
      'orcad_terminal_layout_catalog_not_staged'
    )
  })

  it('rechecks destination catalog drift before admitting', () => {
    const { manifest, bindings, state } = terminalLayoutAdmissionFixture()
    state.repos = [{ ...manifest.payload.repositories[0], path: '/different/path' }]
    expect(() => prepareOrcadTerminalLayoutAdmission(manifest, bindings, state)).toThrow(
      'orcad_migration_repository_id_conflict:'
    )
  })

  it('refuses a modified manifest under the same digest', () => {
    const { admission } = terminalLayoutAdmissionFixture()
    admission.manifest.payload.repositories[0].path = '/changed'
    expect(() => parseOrcadTerminalLayoutAdmission(admission)).toThrow(
      'orcad_migration_manifest_digest_mismatch'
    )
  })

  it.each(['workspace', 'tab', 'leaf', 'pty', 'runtime', 'duplicate'] as const)(
    'refuses a changed %s binding',
    (field) => {
      const admission = structuredClone(terminalLayoutAdmissionFixture().admission)
      const second = admission.bindings[1]
      const changed = {
        ...second,
        identity: {
          ...second.identity,
          ...(field === 'runtime' ? { destinationRuntimeId: 'other' } : {})
        },
        surfaceBinding: {
          ...second.surfaceBinding,
          ...(field === 'workspace' ? { workspaceKey: 'folder:missing' as const } : {}),
          ...(field === 'tab' ? { tabId: 'other' } : {}),
          ...(field === 'leaf' ? { leafId: '33333333-3333-4333-8333-333333333333' } : {}),
          ...(field === 'pty' ? { ptyId: 'other' } : {})
        }
      }
      expect(() =>
        parseOrcadTerminalLayoutAdmission({
          ...admission,
          bindings: [admission.bindings[0], field === 'duplicate' ? admission.bindings[0] : changed]
        })
      ).toThrow('orcad_terminal_layout_binding_conflict')
    }
  )
})
