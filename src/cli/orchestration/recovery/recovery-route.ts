import { getPlatformUserDataPath } from '../../runtime/profile/metadata'

export type RecoveryPairingEnv = 'ORCA_PAIRING_CODE' | 'ORCA_REMOTE_PAIRING'

/**
 * Which Orca a command reached and which profile it used, without any secret, so its
 * recovery commands can name the same receipt ledger after a one-shot assignment expires.
 */
export type OrchestrationRecoveryRoute = {
  /** A named environment, reproducible as --environment. */
  environment: string | null
  /** The variable whose pairing code chose the Orca; the code itself is never kept. */
  pairingEnv: RecoveryPairingEnv | null
  /** ORCA_USER_DATA_PATH chose a profile other than the platform default. */
  profileFromEnv: boolean
}

/** The fields a RuntimeClient settles its route and profile with. */
type RoutedClient = {
  readonly isRemote?: boolean
  readonly environmentSelector?: string | null
  readonly userDataPath?: string
}

export function recoveryRouteOf(
  client: RoutedClient,
  env: NodeJS.ProcessEnv = process.env
): OrchestrationRecoveryRoute {
  const environment = client.environmentSelector || null
  // Remote without a named environment means a pairing code; a --pairing-code flag is in argv,
  // which recovery already refuses to repeat, so only an environment variable is named here.
  const pairingEnv =
    client.isRemote !== true || environment
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
    profileFromEnv:
      Boolean(profile) && client.userDataPath === profile && !isPlatformDefault(profile)
  }
}

function isPlatformDefault(userDataPath: string): boolean {
  try {
    return userDataPath === getPlatformUserDataPath()
  } catch {
    return false
  }
}

export type RecoverySelection = {
  /** Selects the original's Orca for the inspect command. */
  target: string[]
  /** Added to the retry when the original's argv alone would not select its Orca again. */
  retryTarget: string[]
  /** The pairing came from this variable, so no command can run standalone. */
  pairingEnv?: RecoveryPairingEnv
}

export function recoverySelection(
  flags: ReadonlyMap<string, string | boolean> | undefined,
  route: OrchestrationRecoveryRoute | undefined
): RecoverySelection {
  // An outer --on send goes through the caller's Orca, suppressing any ambient pairing.
  if (flags?.has('on')) {
    return { target: ['--environment', 'local'], retryTarget: [] }
  }
  const environment = flags?.get('environment')
  if (typeof environment === 'string') {
    return { target: ['--environment', environment], retryTarget: [] }
  }
  if (flags?.has('pairing-code')) {
    return { target: [], retryTarget: [] }
  }
  // The environment chose the Orca, and a one-shot assignment is gone once this command exits.
  if (route?.pairingEnv) {
    return { target: [], retryTarget: [], pairingEnv: route.pairingEnv }
  }
  if (route?.environment) {
    const named = ['--environment', route.environment]
    // A --host in argv selects the same server again; a second selector would conflict with it.
    return { target: named, retryTarget: flags?.has('host') ? [] : named }
  }
  return { target: [], retryTarget: [] }
}
