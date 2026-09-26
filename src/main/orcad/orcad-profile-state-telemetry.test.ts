import { describe, expect, it, vi } from 'vitest'
import {
  emitOrcadProfileStateAuthoritySelected,
  formatOrcadProfileStateAuthoritySelected,
  type OrcadProfileStateAuthoritySelection
} from './orcad-profile-state-telemetry'

const selection: OrcadProfileStateAuthoritySelection = {
  backend: 'sqlite',
  classification: 'json-only',
  authority_mode: 'sqlite-candidate',
  runtime: 'orcad',
  migrated: true
}

describe('orcad profile-state telemetry', () => {
  it('formats a bounded machine-readable authority selection event', () => {
    expect(JSON.parse(formatOrcadProfileStateAuthoritySelected(selection).slice(18))).toEqual({
      event: 'profile_state_authority_selected',
      ...selection
    })
  })

  it('strips unexpected runtime fields before writing the record', () => {
    const selectionWithRuntimeFields = Object.assign({}, selection, {
      database_path: '/private/profile-state.db'
    })
    const line = formatOrcadProfileStateAuthoritySelected(selectionWithRuntimeFields)
    expect(line).not.toContain('database_path')
  })

  it('sends the event to the supplied sink', () => {
    const sink = vi.fn()
    emitOrcadProfileStateAuthoritySelected(selection, sink)
    expect(sink).toHaveBeenCalledOnce()
    expect(sink).toHaveBeenCalledWith(formatOrcadProfileStateAuthoritySelected(selection))
  })

  it('never lets a failing sink block startup', () => {
    expect(() =>
      emitOrcadProfileStateAuthoritySelected(selection, () => {
        throw new Error('closed stderr')
      })
    ).not.toThrow()
  })
})
