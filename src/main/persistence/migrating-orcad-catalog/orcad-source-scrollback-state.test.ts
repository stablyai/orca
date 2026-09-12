import { describe, expect, it } from 'vitest'
import type { OrcadMigrationTerminalScrollbackSnapshot } from '../../../shared/orcad-migration-scrollback'
import { hasDuplicateOrcadMigrationScrollbackDescriptors } from './orcad-source-scrollback-state'

const FIRST: OrcadMigrationTerminalScrollbackSnapshot = {
  tabId: 'tab-1',
  leafId: 'leaf-1',
  ref: `v1-${'1'.repeat(32)}`,
  sha256: 'a'.repeat(64),
  byteLength: 1
}

describe('orcad source scrollback projection', () => {
  it('refuses duplicate refs or tab/leaf identities across merged fragments', () => {
    expect(
      hasDuplicateOrcadMigrationScrollbackDescriptors([
        FIRST,
        { ...FIRST, tabId: 'tab-2', leafId: 'leaf-2' }
      ])
    ).toBe(true)
    expect(
      hasDuplicateOrcadMigrationScrollbackDescriptors([
        FIRST,
        { ...FIRST, ref: `v1-${'2'.repeat(32)}` }
      ])
    ).toBe(true)
    expect(
      hasDuplicateOrcadMigrationScrollbackDescriptors([
        FIRST,
        {
          ...FIRST,
          tabId: 'tab-2',
          leafId: 'leaf-2',
          ref: `v1-${'2'.repeat(32)}`
        }
      ])
    ).toBe(false)
  })
})
