import type { CommandHandler } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import {
  getOptionalNumberFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { rejectRemoteSelectionFlags } from '../dispatch/remote-selection-flag-rejection'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/connection/types'
import type { RuntimeClient } from '../runtime/client'
import type { SshEditableTargetAddResult } from '../../shared/remote-runtime/ssh/ssh-target-management'
import type { SshRepoReadoption } from '../../shared/remote-runtime/ssh/ssh-types'
import { localSuccess } from './local-success-envelope'

export const HOST_ADD_HANDLERS: Record<string, CommandHandler> = {
  // Why: registration writes this machine's own runtime store — the same reason `host list`
  // refuses runtime selectors instead of answering a half-routed listing.
  'host add': async ({ client, flags, json }) => {
    rejectRemoteSelectionFlags(
      flags,
      '`orca host add`. It writes this machine’s own Orca runtime’s SSH host store, so a routed answer would change a different machine.',
      {
        nextSteps: [
          'Run `orca host add` on that machine to change the hosts registered there.',
          'Drop the flag to change this machine’s hosts.'
        ]
      }
    )
    const host = getRequiredStringFlag(flags, 'host')
    const username = getOptionalStringFlag(flags, 'user') ?? ''
    const port = getOptionalNumberFlag(flags, 'port') ?? 22
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new RuntimeClientError('invalid_argument', '--port must be between 1 and 65535.')
    }
    // Why: same default the add dialog uses — the label is the default display name.
    const label = getOptionalStringFlag(flags, 'name') ?? (username ? `${username}@${host}` : host)
    const identityFile = getOptionalStringFlag(flags, 'key')
    const jumpHost = getOptionalStringFlag(flags, 'jump')
    const target = {
      label,
      host,
      port,
      username,
      // Why: stored as a path reference exactly as typed — the material is never read here.
      ...(identityFile ? { identityFile } : {}),
      ...(jumpHost ? { jumpHost } : {}),
      ...(flags.get('allow-remote-cli-control') === true ? { allowRemoteCliControl: true } : {})
    }
    let added: SshEditableTargetAddResult
    try {
      added = (await client.call<SshEditableTargetAddResult>('ssh.addTarget', { target })).result
    } catch (error) {
      throwIfRuntimeLacksMethod(error, 'register SSH hosts from the CLI')
    }
    const warning = await sameEndpointWarning(client, added.target)
    printResult(
      localSuccess({
        target: added.target,
        repoReadoptions: added.repoReadoptions,
        ...(warning ? { warning } : {})
      }),
      json,
      formatHostAddResult
    )
  }
}

// Why: a runtime older than the registration methods answers `method_not_found`; a bare code
// would read as a bug, so say the host needs an update (same recovery as `host name`).
function throwIfRuntimeLacksMethod(error: unknown, what: string): never {
  if (error instanceof RuntimeRpcFailureError && error.code === 'method_not_found') {
    throw new RuntimeClientError(
      'incompatible_runtime',
      `This Orca runtime cannot ${what}. Update Orca on that host and try again.`
    )
  }
  throw error
}

/** Informational twin-host notice; skipped silently when the host predates the inventory method. */
async function sameEndpointWarning(
  client: RuntimeClient,
  added: { id: string; host: string; port: number; label: string }
): Promise<string | undefined> {
  let targets: { id: string; host: string; port: number; label: string }[]
  try {
    targets = (
      await client.call<{ targets: { id: string; host: string; port: number; label: string }[] }>(
        'ssh.listEditableTargets'
      )
    ).result.targets
  } catch (error) {
    if (error instanceof RuntimeRpcFailureError && error.code === 'method_not_found') {
      return undefined
    }
    throw error
  }
  const twin = targets.find(
    (target) =>
      target.id !== added.id &&
      target.host === added.host &&
      target.port === added.port &&
      target.label !== added.label
  )
  return twin
    ? `An existing target "${twin.label}" (${twin.id}) points at the same ${added.host}:${added.port}.`
    : undefined
}

type HostAddResult = {
  target: { id: string; label: string; host: string; port: number }
  repoReadoptions: SshRepoReadoption[]
  warning?: string
}

function formatHostAddResult(result: HostAddResult): string {
  const lines = [
    `Registered SSH host ${result.target.label} (${result.target.id}).`,
    `Use it with --host ssh:${result.target.id}; run \`orca host list\` to see it alongside the other hosts.`
  ]
  for (const readoption of result.repoReadoptions) {
    lines.push(
      `Re-pointed ${readoption.repoIds.length} workspace(s) from ${readoption.oldTargetId} to ${readoption.newTargetId}.`
    )
  }
  if (result.warning) {
    lines.push(`Warning: ${result.warning}`)
  }
  return lines.join('\n')
}
