import type { CellAdmissionMembership } from './cell-admission-selector.js'

export const STAGING_ASIA_PROOF_CELL_ID = 'staging-gce-c4'

export type StagingAsiaProofAdmissionState = 'general' | 'migration-only'

export function stagingAsiaProofMembership(
  current: CellAdmissionMembership,
  state: StagingAsiaProofAdmissionState
): CellAdmissionMembership {
  const currentStates = [
    current.existingOnly.includes(STAGING_ASIA_PROOF_CELL_ID),
    current.migrationOnly.includes(STAGING_ASIA_PROOF_CELL_ID),
    current.general.includes(STAGING_ASIA_PROOF_CELL_ID)
  ]
  if (currentStates.filter(Boolean).length !== 1 || currentStates[0]) {
    throw new Error('staging_asia_proof_cell_not_transitionable')
  }
  return {
    existingOnly: [...current.existingOnly],
    migrationOnly: current.migrationOnly
      .filter((cellId) => cellId !== STAGING_ASIA_PROOF_CELL_ID)
      .concat(state === 'migration-only' ? [STAGING_ASIA_PROOF_CELL_ID] : [])
      .sort(),
    general: current.general
      .filter((cellId) => cellId !== STAGING_ASIA_PROOF_CELL_ID)
      .concat(state === 'general' ? [STAGING_ASIA_PROOF_CELL_ID] : [])
      .sort()
  }
}
