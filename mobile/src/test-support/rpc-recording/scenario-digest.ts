import { createHash } from 'node:crypto'
import { canonicalJson } from './golden-value-pool'
import { captureValue } from './recording-values'
import type { RecordingScenario } from './recording-scenario'

/**
 * The scenario input one golden was recorded from: every scenario the runner consumed for it, in
 * order — one manifest scenario for a pilot golden, the generated variants (and any hoisted
 * prelude) for a matrix or schedule golden.
 *
 * Pinned per golden rather than over the whole manifest so a family added for one domain moves only
 * its own goldens, while a field edited inside a scenario moves every golden derived from it. The
 * variants are hashed rather than the base they came from because they are what `runRecording`
 * consumed: a matrix site, its replayed normal result and its partition replies are all visible
 * here without the derivation having to be restated.
 *
 * `captureValue` sorts object keys and tags an explicit-undefined param, which `JSON.stringify`
 * would drop and so conflate with an absent one.
 */
export function scenarioSha256(scenarios: readonly RecordingScenario[]): string {
  return createHash('sha256')
    .update(canonicalJson(captureValue(scenarios)))
    .digest('hex')
}
