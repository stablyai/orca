import { createHash } from 'node:crypto'
import { TAB_CLOSE_TELEMETRY_SAMPLE_RATE } from '../../shared/telemetry-tab-event-schemas'

export function isInTabCloseTelemetrySample(installId: string): boolean {
  // Keep the namespace stable so cohort membership survives app restarts and updates.
  const hash = createHash('sha256').update('tabs-directional-close:v1:').update(installId).digest()
  return hash.readUInt32BE(0) / 2 ** 32 < TAB_CLOSE_TELEMETRY_SAMPLE_RATE
}
