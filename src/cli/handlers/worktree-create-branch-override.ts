import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { hasReachedAppVersion } from '../../shared/app-version'
import type { RuntimeStatus } from '../../shared/runtime-types'

const BRANCH_NAME_OVERRIDE_MIN_RUNTIME_VERSION = '1.4.5'
// Why: v1.4.5 shipped the RPC field with protocol 3 before status exposed appVersion.
const BRANCH_NAME_OVERRIDE_MIN_RUNTIME_PROTOCOL_VERSION = 3

async function assertBranchNameOverrideSupported(
  client: Parameters<CommandHandler>[0]['client']
): Promise<void> {
  const status = await client.call<RuntimeStatus>('status.get')
  const protocolVersion = status.result.runtimeProtocolVersion ?? status.result.protocolVersion ?? 0
  const supported =
    protocolVersion >= BRANCH_NAME_OVERRIDE_MIN_RUNTIME_PROTOCOL_VERSION ||
    hasReachedAppVersion(status.result.appVersion ?? '', BRANCH_NAME_OVERRIDE_MIN_RUNTIME_VERSION)
  if (!supported) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'Branch overrides require Orca runtime v1.4.5 or newer. Update the selected runtime and try again.'
    )
  }
}

/**
 * Resolve branchNameOverride for `orca worktree create`.
 *
 * Directory names are sanitized (including `/` → `-`). The git branch can
 * still keep slashes when the caller supplies `--branch`, or when `--name`
 * itself contains `/` (composer branch mode #6721 / CLI #13011).
 */
export function resolveCliWorktreeCreateBranchNameOverride(args: {
  name: string
  branch: string | undefined
}): string | undefined {
  const explicit = args.branch?.trim()
  if (explicit) {
    return explicit
  }
  return args.name.includes('/') ? args.name : undefined
}

export async function resolveCliWorktreeCreateBranchOverride(args: {
  client: Parameters<CommandHandler>[0]['client']
  repo: string
  name: string
  branch: string | undefined
}): Promise<string | undefined> {
  const branchNameOverride = resolveCliWorktreeCreateBranchNameOverride(args)
  if (!branchNameOverride) {
    return undefined
  }
  const result = await args.client.call<{ repo: { kind?: string } }>('repo.show', {
    repo: args.repo
  })
  if (result.result.repo.kind !== 'folder') {
    await assertBranchNameOverrideSupported(args.client)
    return branchNameOverride
  }
  if (args.branch?.trim()) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--branch is only supported for git repositories, not folder workspaces.'
    )
  }
  return undefined
}
