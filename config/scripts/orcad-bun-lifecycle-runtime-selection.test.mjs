import { describe, expect, it } from 'vitest'
import {
  selectOrcadLifecycleRuntime,
  selectOrcadLifecycleArtifact
} from './orcad-bun-lifecycle-runtime-selection.mjs'

describe('selectOrcadLifecycleRuntime', () => {
  it('uses the legacy artifact only for Node migration legs', () => {
    const options = { bunArtifactDir: '/candidate', legacyArtifactDir: '/legacy' }
    expect(selectOrcadLifecycleArtifact({ ...options, migrationMode: true })).toBe('/legacy')
    expect(selectOrcadLifecycleArtifact({ ...options, migrationMode: false })).toBe('/candidate')
  })

  it('preserves the single-artifact fixture when no legacy slot is supplied', () => {
    expect(
      selectOrcadLifecycleArtifact({ migrationMode: true, bunArtifactDir: '/candidate' })
    ).toBe('/candidate')
  })
  it('selects the invoking Node executable for migration mode', () => {
    expect(
      selectOrcadLifecycleRuntime({
        migrationMode: true,
        bundledBun: '/artifact/bun-runtime',
        hostNodeRuntime: '/usr/local/bin/node'
      })
    ).toBe('/usr/local/bin/node')
  })

  it('selects the bundled Bun executable for the normal lifecycle', () => {
    expect(
      selectOrcadLifecycleRuntime({
        migrationMode: false,
        bundledBun: '/artifact/bun-runtime',
        hostNodeRuntime: '/usr/local/bin/node'
      })
    ).toBe('/artifact/bun-runtime')
  })
})
