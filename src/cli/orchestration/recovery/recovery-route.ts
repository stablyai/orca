import { isLocalEnvironmentSelector } from '../../hosts/local-environment-selector'

export type RecoveryPairingEnv = 'ORCA_PAIRING_CODE' | 'ORCA_REMOTE_PAIRING'

/**
 * Which Orca a command reached and how its profile was chosen, without any secret, so recovery
 * names the same receipt ledger after a one-shot assignment expires, or says it cannot.
 */
export type OrchestrationRecoveryRoute = {
  /** The named environment the client used. */
  environment: string | null
  /** The variable whose pairing code chose the Orca; the code itself is never kept. */
  pairingEnv: RecoveryPairingEnv | null
  /** Whether the client reached a remote Orca; null when unknown. */
  remote: boolean | null
  /** ORCA_USER_DATA_PATH for this command: an empty or set value can be a one-shot override. */
  profileEnv: 'unset' | 'empty' | 'set'
}

/** The fields a RuntimeClient settles its route and profile with. */
type RoutedClient = {
  readonly isRemote?: boolean
  readonly environmentSelector?: string | null
}

export function recoveryRouteOf(
  client: RoutedClient,
  env: NodeJS.ProcessEnv = process.env
): OrchestrationRecoveryRoute {
  const environment = client.environmentSelector || null
  const remote = typeof client.isRemote === 'boolean' ? client.isRemote : null
  // Remote without a named environment means a pairing code. The client takes
  // ORCA_PAIRING_CODE ?? ORCA_REMOTE_PAIRING; a --pairing-code flag is in argv instead.
  const pairingEnv =
    remote !== true || environment
      ? null
      : env.ORCA_PAIRING_CODE
        ? 'ORCA_PAIRING_CODE'
        : env.ORCA_PAIRING_CODE === undefined && env.ORCA_REMOTE_PAIRING
          ? 'ORCA_REMOTE_PAIRING'
          : null
  const profile = env.ORCA_USER_DATA_PATH
  return {
    environment,
    pairingEnv,
    remote,
    profileEnv: profile === undefined ? 'unset' : profile === '' ? 'empty' : 'set'
  }
}

export type RecoveryGuidance = {
  /** Selects the original's Orca for the inspect command. */
  target: string[]
  /** Added to the retry when the original's argv alone would not select its Orca again. */
  retryTarget: string[]
  /** Set when no argv can select the original's Orca: the shell conditions that must hold instead. */
  restore?: string
  /** Conditions that hold for every recovery command, emitted or not. */
  caveats: string[]
  /** Variables those conditions name; their values are never repeated. */
  requiredEnv: string[]
}

const PAIRING_UNSET =
  'These commands name their Orca with --environment, so run them where ORCA_PAIRING_CODE and ORCA_REMOTE_PAIRING are unset or empty.'

export function recoveryGuidance(
  flags: ReadonlyMap<string, string | boolean> | undefined,
  route: OrchestrationRecoveryRoute | undefined
): RecoveryGuidance {
  const guidance = routeGuidance(flags, route)
  // No flag chooses a profile, so an ORCA_USER_DATA_PATH override is reproduced only by the shell.
  if (route?.profileEnv === 'empty') {
    guidance.caveats.push(
      'This command ran with ORCA_USER_DATA_PATH empty, so run these where it is unset or empty; another profile keeps a different record of it.'
    )
    guidance.requiredEnv.push('ORCA_USER_DATA_PATH')
  } else if (route?.profileEnv === 'set') {
    guidance.caveats.push(
      'Run these where ORCA_USER_DATA_PATH names the same Orca profile as for this command; another profile keeps a different record of it.'
    )
    guidance.requiredEnv.push('ORCA_USER_DATA_PATH')
  }
  return guidance
}

function routeGuidance(
  flags: ReadonlyMap<string, string | boolean> | undefined,
  route: OrchestrationRecoveryRoute | undefined
): RecoveryGuidance {
  const none = (): RecoveryGuidance => ({
    target: [],
    retryTarget: [],
    caveats: [],
    requiredEnv: []
  })
  // An outer --on send goes through the caller's Orca, suppressing any ambient pairing.
  if (flags?.has('on')) {
    return { ...none(), target: ['--environment', 'local'] }
  }
  const environment = flags?.get('environment')
  if (typeof environment === 'string') {
    const named = !isLocalEnvironmentSelector(environment)
    return {
      ...none(),
      target: environmentArgs(environment),
      caveats: named ? [PAIRING_UNSET] : []
    }
  }
  if (flags?.has('pairing-code')) {
    return none()
  }
  if (route?.pairingEnv) {
    // The client prefers ORCA_PAIRING_CODE, so the fallback wins again only while it is unset.
    const pairing =
      route.pairingEnv === 'ORCA_PAIRING_CODE'
        ? 'ORCA_PAIRING_CODE is set to the same pairing as for this command'
        : 'ORCA_REMOTE_PAIRING is set to the same pairing as for this command and ORCA_PAIRING_CODE is unset'
    return {
      ...none(),
      restore: `${pairing}, and ORCA_ENVIRONMENT is unset or empty`,
      requiredEnv:
        route.pairingEnv === 'ORCA_PAIRING_CODE'
          ? [route.pairingEnv]
          : [route.pairingEnv, 'ORCA_PAIRING_CODE']
    }
  }
  if (route?.environment) {
    // --environment local always means this machine, so a saved server named local is not reachable by name.
    if (isLocalEnvironmentSelector(route.environment)) {
      return {
        ...none(),
        restore:
          'ORCA_ENVIRONMENT names the same saved server as for this command, and ORCA_PAIRING_CODE and ORCA_REMOTE_PAIRING are unset or empty',
        requiredEnv: ['ORCA_ENVIRONMENT']
      }
    }
    const named = environmentArgs(route.environment)
    // A --host in argv selects the same server again; a second selector would conflict with it.
    return {
      ...none(),
      target: named,
      retryTarget: flags?.has('host') ? [] : named,
      caveats: [PAIRING_UNSET]
    }
  }
  // A known-local client stays local even if an ORCA_ENVIRONMENT or pairing export returns.
  if (route?.remote === false) {
    return {
      ...none(),
      target: ['--environment', 'local'],
      retryTarget: ['--environment', 'local']
    }
  }
  return none()
}

/** Assignment form keeps a name that looks like an option a value, not a flag. */
function environmentArgs(name: string): string[] {
  return name.startsWith('-') ? [`--environment=${name}`] : ['--environment', name]
}
