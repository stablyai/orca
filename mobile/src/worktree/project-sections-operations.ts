import { z } from 'zod'
import { MOBILE_PROJECT_SECTIONS_METHOD } from '../../../src/shared/mobile-project-sections-contract'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import type { ProjectHostSetupMethod } from '../../../src/shared/project-types'
import type { ProjectGroup, ProjectGroupCreatedFrom } from '../../../src/shared/project-group-types'
import type { RepoKind } from '../../../src/shared/repo-types'
import type { ProjectOrderBy } from '../../../src/shared/ui-chrome-types'
import { hostUnionArms, salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { isMobileMethodUnavailableError } from '../transport/mobile-method-unavailable'
import type { RpcResponse } from '../transport/types'
import type { SectionRepo } from './workspace-list-types'

const SETUP_METHOD_ARMS = hostUnionArms<ProjectHostSetupMethod>({
  'legacy-repo': true,
  'imported-existing-folder': true,
  cloned: true,
  provisioned: true
})
const REPO_KIND_ARMS = hostUnionArms<RepoKind>({ git: true, folder: true })
const PROJECT_ORDER_BY_ARMS = hostUnionArms<ProjectOrderBy>({ manual: true, recent: true })

// A host id the desktop spells; normalized, so a spelling this build cannot read drops.
const hostIdSchema = z.string().transform((value, ctx) => {
  const hostId = normalizeExecutionHostId(value)
  if (!hostId) {
    ctx.addIssue({ code: 'custom', message: 'unknown host id' })
    return z.NEVER
  }
  return hostId
})

const repoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  path: z.string(),
  badgeColor: salvagedOptional('badgeColor', z.string()),
  addedAt: salvagedOptional('addedAt', z.number()),
  connectionId: salvagedOptional('connectionId', z.string().nullable()),
  executionHostId: salvagedOptional('executionHostId', hostIdSchema),
  // Decoded where drawn (readMobileRepoIcon), so an arm this build lacks still keeps the row.
  repoIcon: z.unknown().optional()
}) satisfies z.ZodType<SectionRepo, unknown>

const setupSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  hostId: hostIdSchema,
  repoId: z.string(),
  path: z.string(),
  displayName: z.string(),
  // Why the fallback: only 'provisioned' changes grouping, so a newer arm groups as a checkout.
  setupMethod: z.enum(SETUP_METHOD_ARMS).catch('legacy-repo'),
  kind: salvagedOptional('kind', z.enum(REPO_KIND_ARMS)),
  connectionId: salvagedOptional('connectionId', z.string().nullable()),
  executionHostId: salvagedOptional('executionHostId', hostIdSchema)
})

const PROJECT_GROUP_CREATED_FROM_ARMS = hostUnionArms<ProjectGroupCreatedFrom>({
  manual: true,
  'folder-scan': true,
  migration: true
})

const projectGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentPath: z.string().nullable(),
  connectionId: salvagedOptional('connectionId', z.string().nullable()),
  executionHostId: salvagedOptional('executionHostId', z.string().nullable()),
  parentGroupId: z.string().nullable(),
  createdFrom: z.enum(PROJECT_GROUP_CREATED_FROM_ARMS).catch('manual'),
  tabOrder: z.number(),
  isCollapsed: z.boolean(),
  color: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
}) satisfies z.ZodType<ProjectGroup, unknown>

const catalogSchema = z.object({
  repos: salvagingArray(repoSchema),
  projects: salvagingArray(z.object({ id: z.string(), displayName: z.string() })),
  setups: salvagingArray(setupSchema),
  // Until the phone has read the shared UI value (projectOrderBy, ui.get), it orders by this.
  projectOrderBy: z.enum(PROJECT_ORDER_BY_ARMS).catch('manual'),
  // Every host's project groups, for a list built from the sidebar feed; older desktops omit it.
  projectGroups: salvagedOptional('projectGroups', salvagingArray(projectGroupSchema))
})

/** The desktop sidebar's Project grouping inputs, as this phone reads them. */
export type ServedProjectSections = z.output<typeof catalogSchema>

/** The sidebar's Project grouping inputs; null until a desktop window has published them. */
export const projectSectionsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'mobileRelay.projectSections-or-skip',
    method: MOBILE_PROJECT_SECTIONS_METHOD,
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'project-sections',
      z.object({ catalog: catalogSchema.nullable() }).transform(({ catalog }) => catalog)
    )
  })
)

/** A host's own project groups, which a feed-built list files folder workspaces under. */
export const hostProjectGroupsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'projectGroup.host-groups-or-skip',
    method: 'projectGroup.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'project-groups',
      z.object({ groups: salvagingArray(projectGroupSchema) }).transform(({ groups }) => groups)
    )
  })
)

/**
 * The desktop's sidebar catalog: absent (null) on a desktop that predates the read, and left
 * as it was after a transient failure, so a dropped reply never regroups the list.
 */
export function readServedProjectSections(
  reply: RpcResponse | null
): { kind: 'answered'; value: ServedProjectSections | null } | { kind: 'kept' } {
  if (!reply) {
    return { kind: 'kept' }
  }
  if (!reply.ok) {
    return isMobileMethodUnavailableError(reply.error.code, reply.error.message)
      ? { kind: 'answered', value: null }
      : { kind: 'kept' }
  }
  try {
    const verdict = projectSectionsRead.interpret(reply)
    return verdict.accepted ? { kind: 'answered', value: verdict.value } : { kind: 'kept' }
  } catch {
    return { kind: 'kept' }
  }
}
