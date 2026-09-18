import { join } from 'node:path'

import { IntegrationHealthStore, readIntegrationHealthMetadata } from './integration-health'

const INTEGRATION_HEALTH_FILE = 'integration-health.json'

/** Persist a loader/delivery receipt emitted by the host's validated hook receiver.
 *
 *  Takes the endpoint directory rather than a file path on purpose: a caller that builds
 *  the path itself evaluates that expression outside this guard, and one such call site
 *  threw on a null endpoint and dropped the hook event it was only meant to observe.
 *  Resolving it here makes every caller safe by construction. */
export function recordIntegrationDelivery(input: {
  source: string
  body: unknown
  executionId: string | undefined
  paneKey: string
  host: 'local' | 'remote'
  healthDir: string | null | undefined
}): void {
  if (input.source !== 'opencode' && input.source !== 'auggie') {
    return
  }
  if (!input.healthDir) {
    return
  }
  try {
    const metadata = readIntegrationHealthMetadata(input.body)
    const version =
      typeof metadata.version === 'string' && metadata.version.length > 0
        ? metadata.version
        : undefined
    const artifactId =
      typeof metadata.artifactId === 'string' && metadata.artifactId.length > 0
        ? metadata.artifactId
        : version
          ? `${input.source}:${version}`
          : undefined
    new IntegrationHealthStore({
      filePath: join(input.healthDir, INTEGRATION_HEALTH_FILE)
    }).recordDeliveryEvidence({
      integration: input.source,
      host: input.host,
      scope: input.paneKey,
      ...(artifactId ? { artifactId } : {}),
      ...(version ? { version } : {}),
      ...(input.executionId ? { executionId: input.executionId } : {}),
      // A valid plugin event proves loader acceptance; file materialization alone does not.
      loader: version ? 'loaded' : 'unknown',
      delivery: 'observed'
    })
  } catch {
    // Diagnostics are best effort and must not affect hook acceptance.
  }
}
