import { describe, expect, it } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import {
  getSshTargetSourceKey,
  isLegacySshConfigImportTarget,
  isSshTargetManagedBySource,
  reconcileSshTargetsFromSource
} from './ssh-target-source-reconciliation'

function target(overrides: Partial<SshTarget> & { id: string; label: string }): SshTarget {
  return {
    host: `${overrides.label}.example.com`,
    port: 22,
    username: 'dev',
    ...overrides
  }
}

describe('reconcileSshTargetsFromSource', () => {
  it('plans source-owned updates and new inserts in candidate order', () => {
    const changes = reconcileSshTargetsFromSource({
      source: { kind: 'custom', sourceId: 'inventory-a' },
      existingTargets: [
        target({
          id: 'existing',
          label: 'alpha',
          configHost: 'alpha',
          port: 2200,
          source: 'custom',
          sourceId: 'inventory-a'
        })
      ],
      candidates: [
        target({ id: 'candidate-alpha', label: 'alpha', configHost: 'alpha', port: 2222 }),
        target({ id: 'candidate-beta', label: 'beta', configHost: 'beta' })
      ],
      deletedTargetKeys: new Set()
    })

    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'update',
        id: 'existing',
        updates: expect.objectContaining({
          port: 2222,
          source: 'custom',
          sourceId: 'inventory-a'
        })
      }),
      {
        kind: 'insert',
        target: expect.objectContaining({
          id: 'candidate-beta',
          source: 'custom',
          sourceId: 'inventory-a'
        })
      }
    ])
  })

  it('reserves keys owned by manual targets and other custom sources', () => {
    const changes = reconcileSshTargetsFromSource({
      source: { kind: 'custom', sourceId: 'inventory-a' },
      existingTargets: [
        target({ id: 'manual', label: 'alpha', configHost: 'alpha', source: 'manual' }),
        target({
          id: 'other-source',
          label: 'beta',
          configHost: 'beta',
          source: 'custom',
          sourceId: 'inventory-b'
        })
      ],
      candidates: [
        target({ id: 'candidate-alpha', label: 'alpha', configHost: 'alpha' }),
        target({ id: 'candidate-beta', label: 'beta', configHost: 'beta' })
      ],
      deletedTargetKeys: new Set()
    })

    expect(changes).toEqual([])
  })

  it('suppresses tombstoned and duplicate candidate keys', () => {
    const changes = reconcileSshTargetsFromSource({
      source: { kind: 'custom', sourceId: 'inventory-a' },
      existingTargets: [],
      candidates: [
        target({ id: 'deleted', label: 'alpha', configHost: 'alpha' }),
        target({ id: 'first', label: 'beta', configHost: 'beta' }),
        target({ id: 'duplicate', label: 'beta', configHost: 'beta' })
      ],
      deletedTargetKeys: new Set(['alpha'])
    })

    expect(changes).toEqual([
      {
        kind: 'insert',
        target: expect.objectContaining({ id: 'first', sourceId: 'inventory-a' })
      }
    ])
  })

  it('adopts only the legacy shape when config reconciliation requests it', () => {
    const imported = target({
      id: 'legacy-import',
      label: 'alpha',
      configHost: 'alpha',
      host: '10.0.0.5'
    })
    const manual = target({
      id: 'legacy-manual',
      label: 'beta',
      configHost: 'beta',
      host: 'beta'
    })

    expect(isLegacySshConfigImportTarget(imported)).toBe(true)
    expect(isLegacySshConfigImportTarget(manual)).toBe(false)
    expect(getSshTargetSourceKey(imported)).toBe('alpha')
    expect(
      isSshTargetManagedBySource(
        imported,
        { kind: 'ssh-config' },
        {
          adoptLegacySshConfigTargets: true
        }
      )
    ).toBe(true)
    expect(isSshTargetManagedBySource(manual, { kind: 'ssh-config' })).toBe(false)

    const changes = reconcileSshTargetsFromSource({
      source: { kind: 'ssh-config' },
      existingTargets: [imported, manual],
      candidates: [
        target({ id: 'alpha-next', label: 'alpha', configHost: 'alpha', port: 2222 }),
        target({ id: 'beta-next', label: 'beta', configHost: 'beta', port: 2222 })
      ],
      deletedTargetKeys: new Set(),
      adoptLegacySshConfigTargets: true
    })

    expect(changes).toHaveLength(1)
    expect(changes[0]).toEqual(
      expect.objectContaining({
        kind: 'update',
        id: 'legacy-import',
        updates: expect.objectContaining({ source: 'ssh-config', port: 2222 })
      })
    )
  })

  it('returns no update when source-owned connection fields are unchanged', () => {
    const existing = target({
      id: 'existing',
      label: 'alpha',
      configHost: 'alpha',
      source: 'custom',
      sourceId: 'inventory-a'
    })

    expect(
      reconcileSshTargetsFromSource({
        source: { kind: 'custom', sourceId: 'inventory-a' },
        existingTargets: [existing],
        candidates: [{ ...existing, id: 'candidate', source: undefined, sourceId: undefined }],
        deletedTargetKeys: new Set()
      })
    ).toEqual([])
  })
})
