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
import { getSshTargetIdForExecutionHost, type ExecutionHostId } from '../../shared/execution-host'
import type { RepoKind } from '../../shared/repo-types'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { PROJECT_HOST_SETUP_HOST_TARGET_RUNTIME_CAPABILITY } from '../../shared/worktree-runtime-capabilities'
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
import { findProjectSetups, resolveProjectIdSelector } from '../project-selector'
import { resolveRepoPathArgument } from '../repo-path-arguments'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'

async function callProjectHostSetup<TResult>(
  client: HandlerContext['client'],
  method: string,
  params?: unknown
): Promise<RuntimeRpcSuccess<TResult>> {
  try {
    // Preserve absent params; explicitly passing undefined changes the request shape.
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

// The runtime rejects SSH setup operations regardless of target existence; preserve that refusal.
async function getRequiredHostId(
  flags: Map<string, string | boolean>,
  client: HandlerContext['client']
): Promise<ExecutionHostId> {
  const host = parseHostFlag(flags)
  if (!host) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --host')
  }
  if (host.kind !== 'alias') {
    return host.id
  }
  // Bare aliases must resolve to an id before they can be forwarded.
  const resolved = await resolveHostFlagTarget(flags, client)
  if (!resolved) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --host')
  }
  return resolved.id
}

// Older hosts drop hostId and pick the first setup twin; refuse unsupported host targeting.
async function getOptionalSetupHostId(
  flags: Map<string, string | boolean>,
  client: HandlerContext['client']
): Promise<ExecutionHostId | undefined> {
  if (!flags.has('host')) {
    return undefined
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(PROJECT_HOST_SETUP_HOST_TARGET_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca server cannot pick a project setup by host yet. Update Orca on the server and try again.'
    )
  }
  // Unresolved, like the setup paths: a removed SSH target's stale setup must stay deletable.
  return await getRequiredHostId(flags, client)
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
    const projectSetups =
      projectFilter === undefined
        ? result.result.setups
        : await findProjectSetups(client, result.result.setups, projectFilter)
    const setups = projectSetups.filter(
      (setup) => hostFilter === undefined || hostFilterMatchesHostId(hostFilter, setup.hostId)
    )
    printResult({ ...result, result: { setups } }, json, formatProjectHostSetupList)
  },
  'project setup-existing-folder': async ({ flags, client, cwd, json }) => {
    const rawPath = getRequiredStringFlag(flags, 'path')
    const hostId = await getRequiredHostId(flags, client)
    // SSH paths belong to the target filesystem, even when the runtime connection itself is local.
    const pathIsOffClient = client.isRemote || getSshTargetIdForExecutionHost(hostId) !== null
    const args: ProjectHostSetupExistingFolderArgs = {
      hostId,
      path: resolveRepoPathArgument(rawPath, cwd, pathIsOffClient, 'Remote project setup'),
      kind: getOptionalRepoKind(flags),
      displayName: getOptionalStringFlag(flags, 'display-name'),
      // Last, so a bad local flag fails before the name lookup reaches the server.
      projectId: await resolveProjectIdSelector(client, getRequiredStringFlag(flags, 'project'))
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
      hostId: await getRequiredHostId(flags, client),
      url: getRequiredStringFlag(flags, 'url'),
      destination: resolveRepoPathArgument(
        rawDestination,
        cwd,
        client.isRemote,
        'Project setup clone'
      ),
      displayName: getOptionalStringFlag(flags, 'display-name'),
      projectId: await resolveProjectIdSelector(client, getRequiredStringFlag(flags, 'project'))
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
      // Resolve SSH targets to reject nonexistent hosts; runtime metadata may precede provisioning.
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
      setupMethod: getOptionalIndependentSetupMethod(flags),
      projectId: await resolveProjectIdSelector(client, getRequiredStringFlag(flags, 'project'))
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
      hostId: await getOptionalSetupHostId(flags, client),
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
        setupId: getRequiredStringFlag(flags, 'setup'),
        hostId: await getOptionalSetupHostId(flags, client),
        force: flags.get('force') === true
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
