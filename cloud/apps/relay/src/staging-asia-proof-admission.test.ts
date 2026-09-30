import { describe, expect, it } from 'vitest'
import { stagingAsiaProofMembership } from './staging-asia-proof-admission.js'

describe('staging Asia proof admission', () => {
  it('promotes only C4 and preserves every other cell', () => {
    expect(stagingAsiaProofMembership({
      existingOnly: ['staging-gce-c1'],
      migrationOnly: ['staging-gce-c4'],
      general: ['staging-gce-c2']
    }, 'general')).toEqual({
      existingOnly: ['staging-gce-c1'],
      migrationOnly: [],
      general: ['staging-gce-c2', 'staging-gce-c4']
    })
  })

  it('rolls back only C4', () => {
    expect(stagingAsiaProofMembership({
      existingOnly: ['staging-gce-c1'],
      migrationOnly: [],
      general: ['staging-gce-c2', 'staging-gce-c4']
    }, 'migration-only')).toEqual({
      existingOnly: ['staging-gce-c1'],
      migrationOnly: ['staging-gce-c4'],
      general: ['staging-gce-c2']
    })
  })

  it('rejects absent or irreversible C4 state', () => {
    expect(() => stagingAsiaProofMembership({
      existingOnly: [], migrationOnly: [], general: ['staging-gce-c2']
    }, 'general')).toThrow('staging_asia_proof_cell_not_transitionable')
    expect(() => stagingAsiaProofMembership({
      existingOnly: ['staging-gce-c4'], migrationOnly: [], general: []
    }, 'migration-only')).toThrow('staging_asia_proof_cell_not_transitionable')
  })
})
