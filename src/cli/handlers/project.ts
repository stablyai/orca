import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupCloneArgs,
  ProjectHostSetupCreateArgs,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult
} from '../../shared/project-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { RepoKind } from '../../shared/repo-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import {
  formatProjectHostSetupCreateResult,
  formatProjectHostSetupDeleteResult,
  formatProjectHostSetupList,
  formatProjectHostSetupResult,
  formatProjectHostSetupUpdateResult,
  formatProjectList,
  printResult
} from '../format'
import {
  hostFilterMatchesHostId,
  parseHostFlag,
  resolveHostFlagTarget
} from '../execution-host-flag'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { resolveRepoPathArgument } from '../repo-path-arguments'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'

// Why: an Orca server that predates project host setup answers `method_not_found`, which reads
// as an Orca bug rather than a version gap — and since --host runtime:<id> now routes these
// commands to that server, a client can reach an older host without meaning to. The desktop
// already names this case; match it instead of surfacing the raw dispatcher error.
async function callProjectHostSetup<TResult>(
  client: HandlerContext['client'],
  method: string,
  params?: unknown
): Promise<RuntimeRpcSuccess<TResult>> {
  try {
    // Why: forward the exact arity the caller used; passing an explicit undefined would change
    // the request shape for the no-params methods.
    return params === undefined
      ? await client.call<TResult>(method)
      : await client.call<TResult>(method, params)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca server does not support project host setup yet. Update Orca on the server and try again.'
      )
    }
    throw error
  }
}

async function getResolvedHostId(
  flags: Map<string, string | boolean>,
  client: HandlerContext['client']
): Promise<ExecutionHostId> {
  const host = await resolveHostFlagTarget(flags, client)
  if (!host) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --host')
  }
  return host.id
}

// Why: the setup paths keep the unresolved id on purpose. The runtime rejects every `ssh:` host
// for those operations regardless of whether it exists, so resolving first would answer "no such
// target" and imply the command would have worked with the right id.
function getRequiredHostId(flags: Map<string, string | boolean>): ExecutionHostId {
  const host = parseHostFlag(flags)
  if (!host) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --host')
  }
  return host.id
}

function getOptionalRepoKind(flags: Map<string, string | boolean>): RepoKind | undefined {
  const kind = getOptionalStringFlag(flags, 'kind')
  if (kind === undefined) {
    return undefined
  }
  if (kind === 'git' || kind === 'folder') {
    return kind
  }
  throw new RuntimeClientError('invalid_argument', '--kind must be git or folder')
}

export const PROJECT_HANDLERS: Record<string, CommandHandler> = {
  'project list': async ({ client, json }) => {
    const result = await client.call<{ projects: Project[] }>('project.list')
    printResult(result, json, formatProjectList)
  },
  'project setups': async ({ flags, client, json }) => {
    const projectFilter = getOptionalStringFlag(flags, 'project')
    const hostFilter = await resolveHostFlagTarget(flags, client)
    const result = await callProjectHostSetup<{ setups: ProjectHostSetup[] }>(
      client,
      'projectHostSetup.list'
    )
    const setups = result.result.setups.filter(
      (setup) =>
        (projectFilter === undefined || setup.projectId === projectFilter) &&
        (hostFilter === undefined || hostFilterMatchesHostId(hostFilter, setup.hostId))
    )
    printResult({ ...result, result: { setups } }, json, formatProjectHostSetupList)
  },
  'project setup-existing-folder': async ({ flags, client, cwd, json }) => {
    const rawPath = getRequiredStringFlag(flags, 'path')
    const args: ProjectHostSetupExistingFolderArgs = {
      projectId: getRequiredStringFlag(flags, 'project'),
      hostId: getRequiredHostId(flags),
      path: resolveRepoPathArgument(rawPath, cwd, client.isRemote, 'Remote project setup'),
      kind: getOptionalRepoKind(flags),
      displayName: getOptionalStringFlag(flags, 'display-name')
    }
    const result = await callProjectHostSetup<{ result: ProjectHostSetupResult }>(
      client,
      'projectHostSetup.setupExistingFolder',
      args
    )
    printResult(result, json, formatProjectHostSetupResult)
  },
  'project setup-clone': async ({ flags, client, cwd, json }) => {
    const rawDestination = getRequiredStringFlag(flags, 'destination')
    const args: ProjectHostSetupCloneArgs = {
      projectId: getRequiredStringFlag(flags, 'project'),
      hostId: getRequiredHostId(flags),
      url: getRequiredStringFlag(flags, 'url'),
      destination: resolveRepoPathArgument(
        rawDestination,
        cwd,
        client.isRemote,
        'Project setup clone'
      ),
      displayName: getOptionalStringFlag(flags, 'display-name')
    }
    const result = await callProjectHostSetup<{ result: ProjectHostSetupResult }>(
      client,
      'projectHostSetup.clone',
      args
    )
    printResult(result, json, formatProjectHostSetupResult)
  },
  'project setup-create': async ({ flags, client, cwd, json }) => {
    const path = getOptionalStringFlag(flags, 'path')
    const args: ProjectHostSetupCreateArgs = {
      projectId: getRequiredStringFlag(flags, 'project'),
      // Why: unlike the setup paths below, the runtime does not reject `ssh:` here — this records
      // independent metadata — so an unknown target would persist a row pointing at a machine
      // that does not exist. Resolving catches that. `local` and `runtime:` pass through
      // untouched, because this is also the provisioning path and a runtime host legitimately
      // may not exist yet when its metadata is written.
      hostId: await getResolvedHostId(flags, client),
      setupId: getOptionalStringFlag(flags, 'setup-id'),
      path:
        path === undefined
          ? undefined
          : resolveRepoPathArgument(path, cwd, client.isRemote, 'Project setup create'),
      kind: getOptionalRepoKind(flags),
      displayName: getOptionalStringFlag(flags, 'display-name'),
      worktreeBasePath: getOptionalStringFlag(flags, 'worktree-base-path'),
      gitUsername: getOptionalStringFlag(flags, 'git-username'),
      setupState: getOptionalSetupState(flags),
      setupMethod: getOptionalIndependentSetupMethod(flags)
    }
    const result = await callProjectHostSetup<{ result: ProjectHostSetupCreateResult }>(
      client,
      'projectHostSetup.create',
      args
    )
    printResult(result, json, formatProjectHostSetupCreateResult)
  },
  'project setup-update': async ({ flags, client, cwd, json }) => {
    const path = getOptionalStringFlag(flags, 'path')
    const args: ProjectHostSetupUpdateArgs = {
      setupId: getRequiredStringFlag(flags, 'setup'),
      updates: {
        displayName: getOptionalStringFlag(flags, 'display-name'),
        path:
          path === undefined
            ? undefined
            : resolveRepoPathArgument(path, cwd, client.isRemote, 'Project setup update'),
        worktreeBasePath: getOptionalStringFlag(flags, 'worktree-base-path'),
        gitUsername: getOptionalStringFlag(flags, 'git-username'),
        kind: getOptionalRepoKind(flags),
        setupState: getOptionalSetupState(flags),
        setupMethod: getOptionalSetupMethod(flags)
      }
    }
    const result = await callProjectHostSetup<{ result: ProjectHostSetupUpdateResult }>(
      client,
      'projectHostSetup.update',
      args
    )
    printResult(result, json, formatProjectHostSetupUpdateResult)
  },
  'project setup-delete': async ({ flags, client, json }) => {
    const result = await callProjectHostSetup<{ result: ProjectHostSetupDeleteResult }>(
      client,
      'projectHostSetup.delete',
      {
        setupId: getRequiredStringFlag(flags, 'setup')
      }
    )
    printResult(result, json, formatProjectHostSetupDeleteResult)
  }
}

function getOptionalSetupState(
  flags: Map<string, string | boolean>
): ProjectHostSetupUpdateArgs['updates']['setupState'] {
  const state = getOptionalStringFlag(flags, 'state')
  if (state === undefined) {
    return undefined
  }
  if (
    state === 'ready' ||
    state === 'not-set-up' ||
    state === 'setting-up' ||
    state === 'error' ||
    state === 'unsupported'
  ) {
    return state
  }
  throw new RuntimeClientError(
    'invalid_argument',
    '--state must be ready, not-set-up, setting-up, error, or unsupported'
  )
}

function getOptionalIndependentSetupMethod(
  flags: Map<string, string | boolean>
): ProjectHostSetupCreateArgs['setupMethod'] {
  const method = getOptionalStringFlag(flags, 'method')
  if (method === undefined) {
    return undefined
  }
  if (method === 'imported-existing-folder' || method === 'cloned' || method === 'provisioned') {
    return method
  }
  throw new RuntimeClientError(
    'invalid_argument',
    '--method must be imported-existing-folder, cloned, or provisioned'
  )
}

function getOptionalSetupMethod(
  flags: Map<string, string | boolean>
): ProjectHostSetupUpdateArgs['updates']['setupMethod'] {
  const method = getOptionalStringFlag(flags, 'method')
  if (method === undefined) {
    return undefined
  }
  if (
    method === 'legacy-repo' ||
    method === 'imported-existing-folder' ||
    method === 'cloned' ||
    method === 'provisioned'
  ) {
    return method
  }
  throw new RuntimeClientError(
    'invalid_argument',
    '--method must be legacy-repo, imported-existing-folder, cloned, or provisioned'
  )
}
