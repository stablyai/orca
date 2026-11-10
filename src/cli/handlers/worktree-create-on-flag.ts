import {
  parseWorkspaceTarget,
  type WorkspaceProviderTarget
} from '../../shared/workspace-provider-target'
import { RuntimeClientError } from '../runtime-client'
import { markProviderCreateError } from '../cli-exit-code'

/**
 * `--on <target>`: an existing host behaves exactly like `--host <host>`; a provider target comes
 * back for the provider create. Reads and rewrites `flags` before any request is sent.
 */
const PROVIDER_ONLY_FLAGS = ['size', 'input', 'inputs-file', 'idempotency-key', 'progress']

export function readCreateOnFlag(
  flags: Map<string, string | boolean>
): WorkspaceProviderTarget | undefined {
  const providerOnly = (): void => {
    for (const name of PROVIDER_ONLY_FLAGS) {
      if (flags.has(name)) {
        throw markProviderCreateError(
          new RuntimeClientError(
            'invalid_argument',
            `--${name} applies only to provider targets (--on recipe:<id>, see \`orca provider list\`); drop it.`,
            { field: name }
          )
        )
      }
    }
  }
  if (!flags.has('on')) {
    providerOnly()
    return undefined
  }
  const raw = flags.get('on')
  if (typeof raw !== 'string' || !raw.trim()) {
    throw markProviderCreateError(
      new RuntimeClientError('invalid_argument', '--on needs a target.', { field: 'on' })
    )
  }
  let parsed: ReturnType<typeof parseWorkspaceTarget>
  try {
    parsed = parseWorkspaceTarget(raw)
  } catch (error) {
    throw markProviderCreateError(
      new RuntimeClientError(
        'invalid_argument',
        error instanceof Error ? error.message : String(error),
        { field: 'on' }
      )
    )
  }
  if (parsed.kind === 'provider') {
    if (flags.has('host')) {
      throw markProviderCreateError(
        new RuntimeClientError(
          'invalid_argument',
          'Choose either --on <provider> or --host <host>; a provider creates a new host.',
          { field: 'host' }
        )
      )
    }
    return parsed.target
  }
  providerOnly()
  if (flags.has('repo')) {
    throw markProviderCreateError(
      new RuntimeClientError(
        'invalid_argument',
        `--repo already names the host the workspace runs on; drop --on ${parsed.host}, or use --project with --on to pick a host.`,
        { field: 'on' }
      )
    )
  }
  if (flags.has('host') && flags.get('host') !== parsed.host) {
    throw markProviderCreateError(
      new RuntimeClientError('invalid_argument', 'Pass the host once, with --on or --host.', {
        field: 'host'
      })
    )
  }
  // An existing host keeps today's --host rules exactly.
  flags.set('host', parsed.host)
  flags.delete('on')
  return undefined
}

/** Runs `worktree create` with its `--on` target; a provider create's failures get exit codes 2/4/5. */
export async function withCreateOnTarget(
  flags: Map<string, string | boolean>,
  run: (target: WorkspaceProviderTarget | undefined) => Promise<void>
): Promise<void> {
  const target = readCreateOnFlag(flags)
  try {
    await run(target)
  } catch (error) {
    // Why: scripts using --on <provider> rely on 2/4/5; plain creates keep exit 1 as before.
    throw target ? markProviderCreateError(error) : error
  }
}
