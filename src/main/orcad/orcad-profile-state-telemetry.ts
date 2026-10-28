import type { ProfileStateStorageClassification } from '../persistence/profile-state/profile-state-storage-classification'

/** Exclude paths, profile IDs and serialized state from fleet telemetry. */
export type OrcadProfileStateAuthoritySelection = {
  backend: 'sqlite'
  classification: ProfileStateStorageClassification
  authority_mode: 'sqlite-established'
  runtime: 'orcad'
  migrated: boolean
}

type OrcadProfileStateTelemetrySink = (line: string) => void

export function formatOrcadProfileStateAuthoritySelected(
  selection: OrcadProfileStateAuthoritySelection
): string {
  // Select fields explicitly so structural typing cannot leak extra runtime data.
  return `[orcad-telemetry] ${JSON.stringify({
    event: 'profile_state_authority_selected',
    backend: selection.backend,
    classification: selection.classification,
    authority_mode: selection.authority_mode,
    runtime: selection.runtime,
    migrated: selection.migrated
  })}`
}

/** Use stderr without desktop dependencies; telemetry failures must not block serving. */
export function emitOrcadProfileStateAuthoritySelected(
  selection: OrcadProfileStateAuthoritySelection,
  sink: OrcadProfileStateTelemetrySink = (line) => console.error(line)
): void {
  try {
    sink(formatOrcadProfileStateAuthoritySelected(selection))
  } catch {}
}
