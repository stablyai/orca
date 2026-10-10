import { readSshBridgeCredential } from '../shared/ssh-bridge-credential-env'
import { RuntimeClientError } from './runtime/types'

// Why: these act on this machine directly (its files, accounts, processes) rather than through the
// scoped runtime socket, so the runtime's per-caller permissions can never see them.
const OWNER_MACHINE_COMMANDS: readonly (readonly string[])[] = [
  ['account'],
  ['agent', 'hooks'],
  ['claude-teams'],
  ['environment'],
  ['host', 'list'],
  ['profile'],
  ['serve'],
  ['skills', 'install'],
  ['skills', 'update'],
  ['skills', 'share'],
  ['vm']
]

function isSshBridgeInvocation(env: NodeJS.ProcessEnv = process.env): boolean {
  return readSshBridgeCredential(env) !== null
}

/** Throws when an SSH-bridged invocation asks for something only this machine's owner may do. */
export function refuseOwnerOnlySshBridgeCommand(
  commandPath: readonly string[],
  flags: ReadonlyMap<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!isSshBridgeInvocation(env)) {
    return
  }
  const command = commandPath.join(' ')
  if (OWNER_MACHINE_COMMANDS.some((prefix) => prefix.every((part, i) => commandPath[i] === part))) {
    throw new RuntimeClientError(
      'forbidden',
      `orca ${command} acts on the Orca host machine itself and cannot run from an SSH host. Run it on the Orca host.`
    )
  }
  for (const flag of ['environment', 'pairing-code']) {
    if (flags.has(flag)) {
      throw new RuntimeClientError(
        'forbidden',
        `--${flag} would route through the Orca host's own paired servers and cannot be used from an SSH host.`
      )
    }
  }
}

export function refuseSshBridgeEnvironmentRouting(
  hostEnvironmentId: string | null,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (hostEnvironmentId !== null && isSshBridgeInvocation(env)) {
    throw new RuntimeClientError(
      'forbidden',
      "--host runtime:<id> would route through the Orca host's own paired servers and cannot be used from an SSH host."
    )
  }
}
