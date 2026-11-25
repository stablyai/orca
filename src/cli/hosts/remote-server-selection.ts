import { quoteCliCommandArgument } from '../arguments/shell-command-quote'
import { isLocalEnvironmentSelector } from './local-environment-selector'

/** How this invocation chose a paired server: `label` names it, `flag` repeats it (absent when inherited from the environment). */
export type RemoteServerSelection = { label: string; flag?: string }

export function describeRemoteServerSelection(
  flags: ReadonlyMap<string, string | boolean>,
  env: NodeJS.ProcessEnv = process.env
): RemoteServerSelection | undefined {
  const environment = flags.get('environment')
  if (typeof environment === 'string') {
    const selector: unknown = environment
    // An explicit local route suppresses ambient ORCA_ENVIRONMENT and pairing codes.
    return isLocalEnvironmentSelector(selector)
      ? undefined
      : {
          label: `--environment ${environment}`,
          flag: `--environment ${quoteCliCommandArgument(environment)}`
        }
  }
  if (flags.has('pairing-code')) {
    // Never echo a pairing code into output an agent may log.
    return { label: '--pairing-code', flag: '--pairing-code <same code>' }
  }
  // Checked before --host: the CLI rewrites an ORCA_ENVIRONMENT selection into --host runtime:<id>.
  const ambientEnvironment = env.ORCA_ENVIRONMENT?.trim()
  if (ambientEnvironment) {
    return { label: `ORCA_ENVIRONMENT=${ambientEnvironment}` }
  }
  // An explicit runtime host suppresses ambient pairing codes; its id is also an --environment selector.
  const host = flags.get('host')
  if (typeof host === 'string' && host.startsWith('runtime:')) {
    const environmentId = host.slice('runtime:'.length)
    return {
      label: `--host ${host}`,
      flag: `--environment ${quoteCliCommandArgument(environmentId)}`
    }
  }
  // Same precedence as RuntimeClient: an empty ORCA_PAIRING_CODE still wins and means local.
  const ambientPairing =
    env.ORCA_PAIRING_CODE !== undefined ? 'ORCA_PAIRING_CODE' : 'ORCA_REMOTE_PAIRING'
  return env[ambientPairing]?.trim() ? { label: ambientPairing } : undefined
}
