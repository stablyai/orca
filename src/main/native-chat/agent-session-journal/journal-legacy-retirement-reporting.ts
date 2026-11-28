import { isTelemetryEnabled, track } from '../../telemetry/client'
import { legacyJournalRetirementSchema } from '../../../shared/telemetry/schemas/telemetry-legacy-journal-retirement-schema'
import { setLegacyJournalRetirementHost } from './journal-legacy-retirement-outcome'

/** The cleanup reports where it stopped through the usage-event client, which validates every field. */
export function installLegacyJournalRetirementReporting(): void {
  setLegacyJournalRetirementHost({
    report: async (event) =>
      track('legacy_journal_retirement', legacyJournalRetirementSchema.parse(event)),
    accepting: isTelemetryEnabled
  })
}
