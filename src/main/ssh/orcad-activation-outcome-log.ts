/**
 * The app log line for an update or rollback that did not go through. Status keeps only the
 * latest deferral, so without this the first refusal's code and reason are lost (BUG-17).
 */
import { errorMessage } from '../../shared/error-message'

type Unsettled = { outcome: string; code?: string; reason?: string }

export async function logOrcadActivationOutcome<T extends Unsettled>(
  operation: string,
  run: () => Promise<T>,
  settled: readonly string[]
): Promise<T> {
  let result: T
  try {
    result = await run()
  } catch (error) {
    console.warn(`[orcad] ${operation} failed: ${errorMessage(error)}`)
    throw error
  }
  if (!settled.includes(result.outcome)) {
    console.warn(
      `[orcad] ${operation} ${result.outcome} (${result.code ?? 'no code'}): ${result.reason ?? ''}`
    )
  }
  return result
}
