import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  adoptEndpointProjectHostSetup,
  adoptEndpointRepo
} from '../../shared/endpoint-catalog-adoption'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type {
  Project,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult
} from '../../shared/project-types'
import {
  placeProject,
  type PlacementOwner,
  type PlacementStore,
  type ProjectPlacement,
  type RegistrationCaller,
  type WslPlacement
} from './project-placement'
import { mutateWslProject, UnsentWslSavedClaim } from './wsl-project-registration'

const SetupReply = z.object({
  result: z.object({
    project: z
      .object({
        id: z.string(),
        displayName: z.string(),
        badgeColor: z.string(),
        sourceRepoIds: z.array(z.string()),
        createdAt: z.number(),
        updatedAt: z.number()
      })
      .passthrough(),
    setup: z
      .object({
        id: z.string(),
        projectId: z.string(),
        hostId: z.literal('local'),
        repoId: z.string(),
        path: z.string(),
        displayName: z.string(),
        setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']),
        setupMethod: z.enum(['legacy-repo', 'imported-existing-folder', 'cloned', 'provisioned']),
        createdAt: z.number(),
        updatedAt: z.number()
      })
      .passthrough(),
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
})

/**
 * Setup places its folder once: a WSL owner links it there; anything else returns to the caller's
 * writer. The desktop places on this computer; the runtime on the requested host, as its caller.
 */
export async function placeExistingFolderSetup(
  store: PlacementStore & { getProjects?(): Project[] },
  args: ProjectHostSetupExistingFolderArgs,
  caller: { owner: 'desktop' } | ({ owner: 'runtime' } & RegistrationCaller)
): Promise<
  { hosted: ProjectHostSetupResult } | { placement: Exclude<ProjectPlacement, WslPlacement> }
> {
  if (caller.owner === 'runtime' && !isAbsolute(args.path)) {
    throw new Error('Project path must be an absolute path')
  }
  const owner: PlacementOwner =
    caller.owner === 'desktop'
      ? {
          domain: LOCAL_EXECUTION_HOST_ID,
          fromPairedClient: false,
          claimsOutsideWsl: { scope: 'desktop' }
        }
      : {
          domain: args.hostId,
          fromPairedClient: caller.fromPairedClient,
          claimsOutsideWsl: { scope: 'runtime', executionHostId: args.hostId }
        }
  const placement = await placeProject(store, {
    ...owner,
    operation: 'setup',
    selectedPath: args.path,
    kind: args.kind === 'folder' ? 'folder' : 'git'
  })
  if (placement.kind !== 'wsl') {
    return { placement }
  }
  try {
    return { hosted: await setupProjectOnWslOwner(store, args, placement) }
  } catch (error) {
    if (error instanceof UnsentWslSavedClaim) {
      return { placement: { kind: 'saved', repo: error.repo, admission: placement.admission } }
    }
    throw error
  }
}

/** Linking an existing project must also happen in the guest's catalog transaction. */
async function setupProjectOnWslOwner(
  store: { getProjects?(): Project[] },
  args: ProjectHostSetupExistingFolderArgs,
  owner: WslPlacement
): Promise<ProjectHostSetupResult> {
  // Why: the guest has never seen this desktop's project, so its identity travels with the link.
  const projectProviderIdentity =
    args.projectProviderIdentity ??
    store.getProjects?.().find((project) => project.id === args.projectId)?.providerIdentity
  const response = await mutateWslProject(owner.authority, 'projectHostSetup.setupExistingFolder', {
    ...args,
    hostId: LOCAL_EXECUTION_HOST_ID,
    path: owner.linuxPath,
    ...(projectProviderIdentity ? { projectProviderIdentity } : {})
  })
  const { result } = SetupReply.parse(response)
  const target = { kind: 'environment' as const, environmentId: owner.environmentId }
  return {
    ...result,
    repo: adoptEndpointRepo(target, result.repo),
    setup: adoptEndpointProjectHostSetup(target, result.setup)
  }
}
