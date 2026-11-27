import { isTelemetryEnabled, track } from '../../telemetry/client'
import { setLegacyJournalRetirementHost } from './journal-legacy-retirement-outcome'

/** The cleanup reports where it stopped through the usage-event client, which validates every field. */
export function installLegacyJournalRetirementReporting(): void {
  setLegacyJournalRetirementHost({
    report: async (event) => track('legacy_journal_retirement', { ...event, runtime: 'local' }),
    accepting: isTelemetryEnabled
  })
}
