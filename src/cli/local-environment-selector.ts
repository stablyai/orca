import { normalizeTypedName } from '../shared/typed-name-normalization'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'
import { quoteCliCommandArgument } from './shell-command-quote'

/** `--server local`: the caller's own Orca, even over an ambient ORCA_ENVIRONMENT or pairing code. */
export const LOCAL_ENVIRONMENT = 'local'

export function isLocalEnvironmentSelector(value: unknown): value is string {
  return typeof value === 'string' && normalizeTypedName(value) === LOCAL_ENVIRONMENT
}

/** `local` is reserved, so a saved entry named local is reached only by its id. */
export async function savedEnvironmentNamedLocal(): Promise<{ id: string } | undefined> {
  const [{ getDefaultUserDataPath }, { listEnvironments }] = await Promise.all([
    import('./runtime-client.js'),
    import('../shared/remote-runtime/host-store/runtime-environment-store.js')
  ])
  return listEnvironments(getDefaultUserDataPath()).find((environment) =>
    isLocalEnvironmentSelector(environment.name)
  )
}

/** `orca server …` management commands act on a saved entry named by --server; `server name` is routed. */
export function isServerManagementCommand(commandPath: readonly string[]): boolean {
  return commandPath[0] === 'server' && commandPath[1] !== 'name'
}

/** Management commands take --server as a saved entry to act on; local is not one. */
export async function refuseLocalManagementSelector(
  commandPath: readonly string[],
  flags: Map<string, string | boolean>
): Promise<void> {
  if (!isServerManagementCommand(commandPath) || !isLocalEnvironmentSelector(flags.get('server'))) {
    return
  }
  const named = await savedEnvironmentNamedLocal()
  throw new RuntimeClientError(
    'invalid_argument',
    `--server local is the Orca on this computer, not a saved server, so \`orca ${commandPath.join(' ')}\` can't act on it.`,
    {
      nextSteps: [
        ...(named
          ? [`A saved server named local is reached by its id: --server ${named.id}.`]
          : []),
        'Run `orca server list` to see saved servers.'
      ]
    }
  )
}

export function refuseReservedEnvironmentName(name: string): void {
  if (isLocalEnvironmentSelector(name)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '`local` is reserved: --server local always means the Orca on this computer. Save the server under another name.'
    )
  }
}

/** cwd shortcuts (current, active) resolve only on the caller's own Orca. */
export function assertLocalCwdWorktreeSelector(selector: string, client: RuntimeClient): void {
  if (!client.isRemote) {
    return
  }
  // A paired CLI's cwd belongs to the client filesystem, so it cannot identify server worktrees.
  const server = client.environmentSelector
  throw new RuntimeClientError(
    'invalid_argument',
    `${selector} is a cwd shortcut and resolves only on the Orca on this computer. Pass an explicit server-side worktree selector such as identity:<identity>, id:<repo-id>::<path>, folder:<id>, name:<displayName>, branch:<branch>, issue:<number>, or path:<absolute-server-path>.`,
    {
      nextSteps: [
        server
          ? `List that server's workspaces: \`orca worktree ps --server ${quoteCliCommandArgument(server)} --json\`, then copy a row's address.`
          : 'Save this connection with `orca server add --name <name> --pairing-code <code>`, then list its workspaces with `orca worktree ps --server <name> --json`.',
        'For a workspace on this computer, rerun with --server local.'
      ]
    }
  )
}
