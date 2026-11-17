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
  const ambientEnvironment = env.ORCA_ENVIRONMENT?.trim()
  if (ambientEnvironment) {
    return { label: `ORCA_ENVIRONMENT=${ambientEnvironment}` }
  }
  // Same precedence as RuntimeClient: an empty ORCA_PAIRING_CODE still wins and means local.
  const ambientPairing =
    env.ORCA_PAIRING_CODE !== undefined ? 'ORCA_PAIRING_CODE' : 'ORCA_REMOTE_PAIRING'
  return env[ambientPairing]?.trim() ? { label: ambientPairing } : undefined
}
