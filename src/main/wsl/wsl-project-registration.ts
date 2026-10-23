import { z } from 'zod'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { getWslHostService } from './wsl-host-service-instance'
import type { WslMutationAuthority } from './project-placement'
import type { RpcCallerIdentity } from '../runtime/rpc/rpc-caller-identity'

type WslProjectOperation =
  | { kind: 'add'; path: string; repoKind?: 'git' | 'folder'; displayName?: string }
  | { kind: 'create'; path: string; name: string; repoKind: 'git' | 'folder' }

export function isPairedWslRoutingCaller(caller: RpcCallerIdentity | undefined): boolean {
  return caller?.kind !== 'local-cli' && caller?.kind !== 'desktop'
}

const ProjectReply = z.object({
  repo: z
    .object({
      id: z.string(),
      path: z.string(),
      displayName: z.string(),
      badgeColor: z.string(),
      addedAt: z.number(),
      kind: z.enum(['git', 'folder']).optional()
    })
    .passthrough()
})

const OwnerIdentity = z.object({
  executionHostId: z.string().nullable().optional(),
  connectionId: z.string().nullable().optional()
})

const OwnerRepos = z.object({ repos: z.array(ProjectReply.shape.repo) })
const OwnerSetups = z.object({
  setups: z.array(
    z.object({
      projectId: z.string(),
      repoId: z.string(),
      path: z.string(),
      hostId: z.string(),
      setupMethod: z.enum(['legacy-repo', 'imported-existing-folder', 'cloned', 'provisioned'])
    })
  )
})
const OwnerProjects = z.object({ projects: z.array(z.object({ id: z.string() })) })

export async function listWslOwnerRepos(environmentId: string): Promise<Repo[]> {
  return OwnerRepos.parse(await callWslProjectHost(environmentId, 'repo.list', undefined)).repos
}

/** Existing owner operations also prepare metadata/root on guests whose update was deferred. */
export async function registerOnWslOwner(
  authority: WslMutationAuthority,
  operation: WslProjectOperation
): Promise<{ kind: 'saved' | 'registered'; repo: Repo }> {
  const { environmentId } = authority
  const known = await listWslOwnerRepos(environmentId)
  let response: unknown
  try {
    response = await mutateWslProject(
      authority,
      `repo.${operation.kind}`,
      operation.kind === 'add'
        ? { path: operation.path, kind: operation.repoKind, displayName: operation.displayName }
        : { parentPath: operation.path, name: operation.name, kind: operation.repoKind }
    )
  } catch (error) {
    if (error instanceof UnsentWslSavedClaim) {
      return { kind: 'saved', repo: error.repo }
    }
    throw error
  }
  if (typeof response === 'object' && response && 'error' in response) {
    throw new Error(String(response.error))
  }
  const acknowledged = ProjectReply.parse(response).repo
  let repo: Repo = { ...acknowledged, executionHostId: toRuntimeExecutionHostId(environmentId) }
  try {
    if (operation.repoKind !== 'folder' && !known.some((row) => row.id === repo.id)) {
      const acknowledgedOwner = OwnerIdentity.parse(acknowledged)
      const { setups } = OwnerSetups.parse(
        await callWslProjectHost(environmentId, 'projectHostSetup.list', undefined)
      )
      const setup = setups.find(
        (row) =>
          row.repoId === repo.id &&
          row.path === repo.path &&
          row.hostId === getRepoExecutionHostId(acknowledgedOwner)
      )
      const { projects } = OwnerProjects.parse(
        await callWslProjectHost(environmentId, 'project.list', undefined)
      )
      if (!setup || !projects.some((project) => project.id === setup.projectId)) {
        throw new Error('The project was added, but its host setup could not be prepared.')
      }
      // A concurrent explicit registration owns its provenance, even if our earlier snapshot missed it.
      if (setup.setupMethod === 'legacy-repo' && repo.projectHostSetupMethod == null) {
        const result = await mutateWslProject(authority, 'projectHostSetup.setupExistingFolder', {
          projectId: setup.projectId,
          hostId: LOCAL_EXECUTION_HOST_ID,
          path: repo.path,
          kind: 'git',
          setupMethod: 'imported-existing-folder'
        })
        const prepared = z.object({ result: ProjectReply }).parse(result).result.repo
        if (prepared.id !== repo.id || prepared.path !== repo.path) {
          throw new Error(
            'The project setup returned a different project. Open the added project to finish setup.'
          )
        }
        repo = { ...prepared, executionHostId: toRuntimeExecutionHostId(environmentId) }
      }
    }
  } catch (error) {
    throw new IncompleteWslProject(repo, error)
  }
  return { kind: 'registered', repo }
}

function callWslProjectHost(
  environmentId: string,
  method: 'repo.list' | 'projectHostSetup.list' | 'project.list',
  params: undefined
): Promise<unknown> {
  const service = getWslHostService()
  if (!service) {
    throw new Error('WSL hosts are not available on this computer.')
  }
  return service.callProject(environmentId, method, params)
}

export class UnsentWslSavedClaim extends Error {
  constructor(readonly repo: Repo) {
    super('This project is already saved on Windows.')
  }
}

export class StoppedWslMutation extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'The WSL project operation could not continue.')
  }
}

export class IncompleteWslProject extends Error {
  constructor(
    readonly repo: Repo,
    cause: unknown
  ) {
    super(
      `The project was added on WSL, but its setup could not be completed. ${cause instanceof Error ? cause.message : 'Open the project on its WSL host to finish setup.'}`
    )
  }
}

/** The verdict belongs to this unsent request, surviving transport error translation. */
export async function mutateWslProject(
  authority: WslMutationAuthority,
  method: string,
  params: unknown
): Promise<unknown> {
  const request: { blocked?: { kind: 'saved'; repo: Repo } | { kind: 'stopped'; error: unknown } } =
    {}
  const beforeSend = () => {
    try {
      const repo = authority.validate()
      if (repo) {
        request.blocked = { kind: 'saved', repo }
        throw new Error('This project is already saved on Windows.')
      }
    } catch (error) {
      request.blocked ??= { kind: 'stopped', error }
      throw error
    }
  }
  const service = getWslHostService()
  if (!service) {
    throw new Error('WSL hosts are not available on this computer.')
  }
  try {
    return await service.callProject(authority.environmentId, method, params, beforeSend)
  } catch (error) {
    if (request.blocked?.kind === 'saved') {
      throw new UnsentWslSavedClaim(request.blocked.repo)
    }
    throw request.blocked?.kind === 'stopped'
      ? new StoppedWslMutation(request.blocked.error)
      : error
  }
}
