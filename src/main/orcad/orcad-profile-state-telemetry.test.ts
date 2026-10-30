import { describe, expect, it } from 'vitest'
import {
  emitOrcadProfileStateAuthoritySelected,
  formatOrcadProfileStateAuthoritySelected,
  type OrcadProfileStateAuthoritySelection
} from './orcad-profile-state-telemetry'

const selection: OrcadProfileStateAuthoritySelection = {
  backend: 'sqlite',
  classification: 'json-only',
  authority_mode: 'sqlite-established',
  runtime: 'orcad',
  migrated: true
}

describe('orcad profile-state telemetry', () => {
  it('strips unexpected runtime fields before writing the record', () => {
    const selectionWithRuntimeFields = Object.assign({}, selection, {
      database_path: '/private/profile-state.db'
    })
    const line = formatOrcadProfileStateAuthoritySelected(selectionWithRuntimeFields)
    expect(line).not.toContain('database_path')
  })

  it('never lets a failing sink block startup', () => {
    expect(() =>
      emitOrcadProfileStateAuthoritySelected(selection, () => {
        throw new Error('closed stderr')
      })
    ).not.toThrow()
  })
})
