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
  ProjectHostSetupUpdateResult,
  RepoKind
} from '../../shared/types'
import type { CommandHandler } from '../dispatch'
import {
  formatProjectHostSetupCreateResult,
  formatProjectHostSetupDeleteResult,
  formatProjectHostSetupList,
  formatProjectHostSetupResult,
  formatProjectHostSetupUpdateResult,
  formatProjectList,
  printResult
} from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { resolveRepoPathArgument } from '../repo-path-arguments'
import { RuntimeClientError } from '../runtime-client'

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
    const hostFilter = getOptionalStringFlag(flags, 'host')
    const result = await client.call<{ setups: ProjectHostSetup[] }>('projectHostSetup.list')
    const setups = result.result.setups.filter(
      (setup) =>
        (projectFilter === undefined || setup.projectId === projectFilter) &&
        (hostFilter === undefined || setup.hostId === hostFilter)
    )
    printResult({ ...result, result: { setups } }, json, formatProjectHostSetupList)
  },
  'project setup-existing-folder': async ({ flags, client, cwd, json }) => {
    const rawPath = getRequiredStringFlag(flags, 'path')
    const args: ProjectHostSetupExistingFolderArgs = {
      projectId: getRequiredStringFlag(flags, 'project'),
      hostId: getRequiredStringFlag(flags, 'host') as ProjectHostSetupExistingFolderArgs['hostId'],
      path: resolveRepoPathArgument(rawPath, cwd, client.isRemote, 'Remote project setup'),
      kind: getOptionalRepoKind(flags),
      displayName: getOptionalStringFlag(flags, 'display-name')
    }
    const result = await client.call<{ result: ProjectHostSetupResult }>(
      'projectHostSetup.setupExistingFolder',
      args
    )
    printResult(result, json, formatProjectHostSetupResult)
  },
  'project setup-clone': async ({ flags, client, cwd, json }) => {
    const rawDestination = getRequiredStringFlag(flags, 'destination')
    const args: ProjectHostSetupCloneArgs = {
      projectId: getRequiredStringFlag(flags, 'project'),
      hostId: getRequiredStringFlag(flags, 'host') as ProjectHostSetupCloneArgs['hostId'],
      url: getRequiredStringFlag(flags, 'url'),
      destination: resolveRepoPathArgument(
        rawDestination,
        cwd,
        client.isRemote,
        'Project setup clone'
      ),
      displayName: getOptionalStringFlag(flags, 'display-name')
    }
    const result = await client.call<{ result: ProjectHostSetupResult }>(
      'projectHostSetup.clone',
      args
    )
    printResult(result, json, formatProjectHostSetupResult)
  },
  'project setup-create': async ({ flags, client, cwd, json }) => {
    const path = getOptionalStringFlag(flags, 'path')
    const args: ProjectHostSetupCreateArgs = {
      projectId: getRequiredStringFlag(flags, 'project'),
      hostId: getRequiredStringFlag(flags, 'host') as ProjectHostSetupCreateArgs['hostId'],
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
    const result = await client.call<{ result: ProjectHostSetupCreateResult }>(
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
    const result = await client.call<{ result: ProjectHostSetupUpdateResult }>(
      'projectHostSetup.update',
      args
    )
    printResult(result, json, formatProjectHostSetupUpdateResult)
  },
  'project setup-delete': async ({ flags, client, json }) => {
    const result = await client.call<{ result: ProjectHostSetupDeleteResult }>(
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
