import { buildLocalCliEnvironment } from '../network/local-cli-environment'

/**
 * Build the environment shared by local preflight CLI probes.
 *
 * @returns A local-host CLI environment with current PATH and proxy settings.
 */
export function buildLocalPreflightEnv(): Promise<Record<string, string>> {
  return buildLocalCliEnvironment()
}
