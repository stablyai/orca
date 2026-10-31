import { PersonalProjectOrderSchema } from '../../../src/shared/personal-project-order'
import { z } from 'zod'
import type { PersistedUIState } from '../../../src/shared/persisted-ui-state-types'
import type { RepoIcon } from '../../../src/shared/repo-icon'
import { hostUnionArms, salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import { NODE_PLATFORM_NAMES } from '../transport/mobile-runtime-host-platform'

export const WORKSPACE_GROUP_BY_ARMS = hostUnionArms<PersistedUIState['groupBy']>({
  none: true,
  'workspace-status': true,
  repo: true,
  'pr-status': true
})
export const WORKSPACE_SORT_BY_ARMS = hostUnionArms<PersistedUIState['sortBy']>({
  name: true,
  smart: true,
  recent: true,
  repo: true,
  manual: true
})

const WORKSPACE_PROJECT_ORDER_ARMS = hostUnionArms<PersistedUIState['projectOrderBy']>({
  manual: true,
  recent: true,
  frequent: true,
  name: true
})
const WORKSPACE_AGENT_ACTIVITY_LAYOUT_ARMS = hostUnionArms<
  NonNullable<PersistedUIState['agentActivityDisplayMode']>
>({ compact: true, full: true })

const repoIconBranches = {
  lucide: z.looseObject({ type: z.literal('lucide'), name: z.string() }),
  emoji: z.looseObject({ type: z.literal('emoji'), emoji: z.string() }),
  image: z.looseObject({
    type: z.literal('image'),
    src: z.string(),
    label: salvagedOptional('label', z.string())
  })
} satisfies Readonly<Record<RepoIcon['type'], z.ZodType>>
const mobileRepoIconSchema = z.union([
  repoIconBranches.lucide,
  repoIconBranches.emoji,
  repoIconBranches.image
])

export function readMobileRepoIcon(value: unknown): MobileHostRepoIcon | null {
  const parsed = mobileRepoIconSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

// Drop catalog rows without id/displayName; salvage badgeColor and unknown icon arms to the renderer’s existing fallbacks. path labels older hosts’ repo sections.
// Image icons read only src/label; leave source opaque so newer source arms do not erase usable images.
// Keep host ids as strings: getRepoExecutionHostId already maps unknown spellings to local, preserving newer hosts’ rows.
export const hostRepoCatalogSchema = z
  .looseObject({
    repos: salvagingArray(
      z.looseObject({
        id: z.string(),
        displayName: z.string(),
        path: salvagedOptional('path', z.string()),
        badgeColor: salvagedOptional('badgeColor', z.string()),
        repoIcon: salvagedOptional('repoIcon', mobileRepoIconSchema),
        connectionId: salvagedOptional('connectionId', z.string().nullable()),
        executionHostId: salvagedOptional('executionHostId', z.string().nullable())
      })
    )
  })
  .transform((reply) => reply.repos)

// Keep target parsing total: absent/malformed targets yield [] and labels degrade to host ids on older hosts. A throw here would also skip the subsequent platform write.
export const hostSshTargetSummariesSchema = z
  .looseObject({
    targets: salvagedOptional(
      'targets',
      salvagingArray(
        z.looseObject({
          id: z.string(),
          label: z.string(),
          // Read raw: an arm a newer desktop adds must leave the badge as it is, not read as a verdict.
          connected: salvagedOptional('connected', z.boolean()),
          connectionStatus: salvagedOptional('connectionStatus', z.string())
        })
      )
    )
  })
  .transform((reply) => reply.targets ?? [])
  .catch(() => [])

// Use the host’s process.platform, never the phone’s. Unknown/non-string payloads degrade to null, preserving later metadata writes.
// The closed arm set follows Node’s platform domain, which determines path conventions.
export const hostPlatformSchema = z
  .looseObject({ platform: salvagedOptional('platform', z.enum(NODE_PLATFORM_NAMES)) })
  .transform((reply) => reply.platform ?? null)
  .catch(() => null)

// Salvage settings to the current local value; unknown group/sort arms already have mapping fallbacks.
// Keep status rows opaque but require an array for downstream find calls; retain the ui wrapper requirement so malformed replies reach the existing screen catch.
export const hostViewSettingsSchema = z
  .looseObject({
    ui: z.looseObject({
      groupBy: salvagedOptional('groupBy', z.enum(WORKSPACE_GROUP_BY_ARMS)),
      sortBy: salvagedOptional('sortBy', z.enum(WORKSPACE_SORT_BY_ARMS)),
      hideSleepingWorkspaces: salvagedOptional('hideSleepingWorkspaces', z.boolean()),
      hideDefaultBranchWorkspace: salvagedOptional('hideDefaultBranchWorkspace', z.boolean()),
      hideAutomationGeneratedWorkspaces: salvagedOptional(
        'hideAutomationGeneratedWorkspaces',
        z.boolean()
      ),
      hideCliCreatedWorkspaces: salvagedOptional('hideCliCreatedWorkspaces', z.boolean()),
      hideDetachedHeadWorkspaces: salvagedOptional('hideDetachedHeadWorkspaces', z.boolean()),
      // Sent only to this host's own phone (client-ui.ts); absent means the host keeps it local.
      hideWorkspacesFromOtherDevices: salvagedOptional(
        'hideWorkspacesFromOtherDevices',
        z.boolean()
      ),
      personalProjectOrder: salvagedOptional('personalProjectOrder', PersonalProjectOrderSchema),
      projectOrderBy: salvagedOptional('projectOrderBy', z.enum(WORKSPACE_PROJECT_ORDER_ARMS)),
      // Kept as strings: a property a newer desktop adds is carried back unchanged on write.
      worktreeCardProperties: salvagedOptional('worktreeCardProperties', z.array(z.string())),
      agentActivityDisplayMode: salvagedOptional(
        'agentActivityDisplayMode',
        z.enum(WORKSPACE_AGENT_ACTIVITY_LAYOUT_ARMS)
      ),
      alwaysShowDefaultBranchWorkspace: salvagedOptional(
        'alwaysShowDefaultBranchWorkspace',
        z.boolean()
      ),
      filterRepoIds: salvagedOptional('filterRepoIds', z.array(z.string())),
      collapsedGroups: salvagedOptional('collapsedGroups', z.array(z.string())),
      workspaceStatuses: salvagedOptional(
        'workspaceStatuses',
        z.array(z.looseObject({ id: z.string(), label: z.string() }))
      ),
      visibleWorkspaceHostIds: salvagedOptional(
        'visibleWorkspaceHostIds',
        z.array(z.string()).nullable()
      ),
      workspaceHostScope: salvagedOptional('workspaceHostScope', z.string())
    })
  })
  .transform((reply) => reply.ui)

// Most writes read acceptance alone; keep activation opaque for its second consumer.
// headlessActivationNeedsHostRenderer is a total guard inside a fire-and-forget startup task: a throwing reader would cause an unhandled rejection and skip terminal loading.
export const hostScreenUnreadReplySchema = z.unknown()

export type HostRepoCatalogRow = z.output<typeof hostRepoCatalogSchema>[number]

export type MobileHostRepoIcon = NonNullable<
  z.output<typeof hostRepoCatalogSchema>[number]['repoIcon']
>

export type MobileRenderableRepoIcon = MobileHostRepoIcon | RepoIcon
