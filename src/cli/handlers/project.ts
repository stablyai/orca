import type {
  Project,
  ProjectGroup,
  ProjectHostSetup,
  ProjectHostSetupCloneArgs,
  ProjectHostSetupCreateArgs,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult,
  Repo,
  RepoKind
} from '../../shared/types'
import type { CommandHandler } from '../dispatch'
import {
  formatProjectGroupAddResult,
  formatProjectGroupCreateResult,
  formatProjectGroupDeleteResult,
  formatProjectGroupList,
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
import type { RuntimeClient } from '../runtime-client'
import {
  assertWorkspaceTargetFlagsCompatible,
  resolveProjectCreateRepoSelector
} from '../worktree-project-target'

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
  },
  'project group create': async ({ flags, client, json }) => {
    const result = await client.call<{ group: ProjectGroup }>('projectGroup.create', {
      name: getRequiredStringFlag(flags, 'name'),
      parentPath: getOptionalStringFlag(flags, 'parent-path')
    })
    printResult(result, json, formatProjectGroupCreateResult)
  },
  'project group list': async ({ client, json }) => {
    const result = await client.call<{ groups: ProjectGroup[] }>('projectGroup.list')
    printResult(result, json, formatProjectGroupList)
  },
  'project group add': async ({ flags, client, json }) => {
    assertWorkspaceTargetFlagsCompatible(flags)
    const groupId = getRequiredStringFlag(flags, 'group')
    const repo = await resolveProjectGroupTargetRepo(flags, client)
    const result = await client.call<{ repo: Repo }>('projectGroup.moveProject', {
      repo,
      groupId
    })
    printResult(result, json, formatProjectGroupAddResult)
  },
  'project group rm': async ({ flags, client, json }) => {
    const result = await client.call<{ deleted: boolean }>('projectGroup.delete', {
      groupId: getRequiredStringFlag(flags, 'group')
    })
    printResult(result, json, formatProjectGroupDeleteResult)
  }
}

/**
 * Resolve the repo a `project group add` should move, accepting the same
 * selector forms as `orca worktree create`: a project target (--project with
 * optional --host, or --project-host-setup) or a direct --repo selector.
 */
async function resolveProjectGroupTargetRepo(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<string> {
  const projectRepoSelector = await resolveProjectCreateRepoSelector(flags, client)
  if (projectRepoSelector) {
    return projectRepoSelector
  }
  const explicitRepo = getOptionalStringFlag(flags, 'repo')
  if (explicitRepo) {
    return explicitRepo
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'Missing project selector. Pass --project <id> [--host <host-id>], --project-host-setup <id>, or --repo <selector>.'
  )
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
