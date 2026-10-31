import { describe, expect, it } from 'vitest'
import { runtimeClientRelayAdmission } from './runtime-client-relay-admission'

describe('runtimeClientRelayAdmission', () => {
  it('refuses a relay the client could not run here, so the server never widens its grants', () => {
    const request = { method: 'terminal.list', executionHost: 'runtime:env-1' }
    expect(
      runtimeClientRelayAdmission(
        request,
        { kind: 'runtime-paired', grants: [] },
        'desktop-control'
      )
    ).toMatchObject({ kind: 'refused', code: 'forbidden' })
    expect(
      runtimeClientRelayAdmission(
        request,
        { kind: 'runtime-paired', grants: ['desktop-control'] },
        'desktop-control'
      )
    ).toEqual({ kind: 'relay' })
  })
})
