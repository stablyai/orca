import { z } from 'zod'
import type { PersistedUIState } from '../../../src/shared/persisted-ui-state-types'
import type { RepoIcon } from '../../../src/shared/repo-icon'
import { hostUnionArms, salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import { NODE_PLATFORM_NAMES } from '../transport/mobile-runtime-host-platform'

// The closed arm sets on this screen are the desktop's own unions, pinned through hostUnionArms so
// an arm the desktop adds or drops fails tsc here rather than degrading silently on the phone.
export const WORKSPACE_GROUP_BY_ARMS = hostUnionArms<PersistedUIState['groupBy']>({
  none: true,
  'workspace-status': true,
  repo: true,
  'pr-status': true,
  tag: true
})
export const WORKSPACE_SORT_BY_ARMS = hostUnionArms<PersistedUIState['sortBy']>({
  name: true,
  smart: true,
  recent: true,
  repo: true,
  manual: true
})

// One branch per RepoIcon arm; `satisfies` over the mapped union fails tsc on a missing or stale arm.
const repoIconBranches = {
  lucide: z.looseObject({ type: z.literal('lucide'), name: z.string() }),
  emoji: z.looseObject({ type: z.literal('emoji'), emoji: z.string() }),
  image: z.looseObject({
    type: z.literal('image'),
    src: z.string(),
    label: salvagedOptional('label', z.string())
  })
} satisfies Readonly<Record<RepoIcon['type'], z.ZodType>>

// What the host screen reads to label its rows and to mirror the desktop's workspace view store.
// Checked against src/main/runtime/rpc/methods/repo.ts:29, ssh.ts:55, host-capabilities.ts:8 and
// client-ui.ts:60/65, and the shared records they return: Repo in src/shared/repo-types.ts:42 and
// PersistedUIState's workspace-view subset in mobile/src/worktree/workspace-view-settings.ts:14.

/**
 * The host's repo catalog, narrowed to what the label maps are built from.
 *
 * `id` and `displayName` are required and a row without either drops: `displayName` is the key of
 * four Maps and the argument `repoColor` hashes with `name.charCodeAt` — a row without one was a
 * TypeError that took the whole metadata refresh with it — and `id` is the Map value the workspace
 * rows resolve their host through.
 *
 * `badgeColor` sits behind main's own `||` fallback to `repoColor`, so a salvaged member draws the
 * same swatch. `repoIcon` is declared as the three arms MobileRepoIcon renders, and an arm this
 * build has not heard of degrades to absent — which is the Folder default that component already
 * drew for an arm it could not match, so the row keeps its label either way.
 * The image arm deliberately stops at `src` and `label`: those are the members the component reads,
 * and `source` — which it never reads — is left to pass through. Declaring it as the four arms
 * `RepoIconImageSource` spells today would have dropped the WHOLE icon for a source a later host
 * adds, drawing a Folder where main drew the image; passthrough keeps the member on the object
 * verbatim, which is also what `settings-repo-metadata-icons` records.
 * `connectionId` and `executionHostId` are declared as plain strings rather than as
 * the host-id template union they are typed with: the union is a wire surface, and
 * `getRepoExecutionHostId` — which is what every read of them goes through — already answers `local`
 * for a spelling it cannot parse. Narrowing them here would refuse a newer host's own rows.
 */
export const hostRepoCatalogSchema = z
  .looseObject({
    repos: salvagingArray(
      z.looseObject({
        id: z.string(),
        displayName: z.string(),
        badgeColor: salvagedOptional('badgeColor', z.string()),
        repoIcon: salvagedOptional(
          'repoIcon',
          z.union([repoIconBranches.lucide, repoIconBranches.emoji, repoIconBranches.image])
        ),
        connectionId: salvagedOptional('connectionId', z.string().nullable()),
        executionHostId: salvagedOptional('executionHostId', z.string().nullable())
      })
    )
  })
  .transform((reply) => reply.repos)

/**
 * The SSH target labels a mixed-host catalog names its rows with.
 *
 * The rows the label builder keeps are exactly the rows with a string `id` and `label`, so the
 * filter that used to sit in `readSshTargets` is the schema now and a row without either drops.
 * `targets` itself is salvaged rather than required because main answered `[]` for a reply without
 * it, and a `[]` here is what makes the labels degrade to host ids — the documented behaviour for a
 * host that predates the method.
 *
 * Total, like the reader it replaces: `readSshTargets` answered `[]` for any payload at all, and
 * the caller writes the labels before it reads the platform, so a throw here would also skip the
 * platform write. The `.catch` keeps a non-object reply degrading exactly where main degraded.
 */
export const hostSshTargetSummariesSchema = z
  .looseObject({
    targets: salvagedOptional(
      'targets',
      salvagingArray(z.looseObject({ id: z.string(), label: z.string() }))
    )
  })
  .transform((reply) => reply.targets ?? [])
  .catch(() => [])

/**
 * The paired host's own platform.
 *
 * Salvaged to absent, which reads as null — main's own answer for a non-string or an empty one
 * (`typeof platform === 'string' && platform`), and the value that keeps the phone's platform from
 * naming the desktop. The arm set is closed over Node's platform domain rather than over anything
 * Orca versions: the handler returns `process.platform` and nothing else, and a string outside that
 * set names no path convention this client could apply.
 *
 * Total for the same reason as the SSH targets above: `readHostPlatform` answered `null` for any
 * payload, so a non-object reply degrades here instead of throwing past the label write.
 */
export const hostPlatformSchema = z
  .looseObject({ platform: salvagedOptional('platform', z.enum(NODE_PLATFORM_NAMES)) })
  .transform((reply) => reply.platform ?? null)
  .catch(() => null)

/**
 * The desktop's shared workspace view settings, read off `ui.get`'s `ui` member.
 *
 * Nothing is required: applyDesktopViewSettings reads every member behind `??` or a mapping table
 * that answers null for an arm it does not know, so a salvaged member leaves the local value in
 * place — which is exactly what main did for an absent one. `groupBy` and `sortBy` are closed arm
 * sets that degrade to absent for the same reason: every read is a lookup that already fell back to
 * the current mode for an arm it could not map, so nothing is withheld that the reply granted.
 *
 * `workspaceStatuses` keeps its rows opaque — coerceMobileWorkspaceStatuses only counts them — but
 * the container is checked, because main handed a non-array straight into the status catalog and
 * every group lookup then read `.find` off a string.
 *
 * The `ui` member itself is required. Main read it off the payload with a bare property access that
 * threw a TypeError on a null result, and the host screen's own try/catch is where that throw has
 * always landed; an incompatible reply reaches the same catch with the method named.
 */
export const hostViewSettingsSchema = z
  .looseObject({
    ui: z.looseObject({
      groupBy: salvagedOptional('groupBy', z.enum(WORKSPACE_GROUP_BY_ARMS)),
      sortBy: salvagedOptional('sortBy', z.enum(WORKSPACE_SORT_BY_ARMS)),
      hideSleepingWorkspaces: salvagedOptional('hideSleepingWorkspaces', z.boolean()),
      hideDefaultBranchWorkspace: salvagedOptional('hideDefaultBranchWorkspace', z.boolean()),
      alwaysShowDefaultBranchWorkspace: salvagedOptional(
        'alwaysShowDefaultBranchWorkspace',
        z.boolean()
      ),
      filterRepoIds: salvagedOptional('filterRepoIds', z.array(z.string())),
      collapsedGroups: salvagedOptional('collapsedGroups', z.array(z.string())),
      workspaceStatuses: salvagedOptional(
        'workspaceStatuses',
        z.array(z.looseObject({ id: z.string(), label: z.string() }))
      )
    })
  })
  .transform((reply) => reply.ui)

/**
 * The four host-list writes whose reply body no call site reads.
 *
 * The `ui.set` patch, the pin write, the row delete and the activate ping are all decided by the
 * acceptance verdict alone — the pin write never interprets its reply at all, and the delete reads
 * `accepted` and nothing else.
 *
 * `worktree.activate` is the one of the four whose payload a *second* consumer looks at, and it is
 * deliberately left opaque: headlessActivationNeedsHostRenderer is a total guard over `unknown`
 * (worktree-activation-result.ts:1), and the session route's second report site
 * (use-mobile-session-startup.ts:170) reports from inside a fire-and-forget `void (async …)()` with
 * no catch of its own, so a reader that could throw would turn an unreadable activation into an
 * unhandled rejection *and* skip the terminal fetch below it, where main showed no toast and
 * fetched. This schema staying total is what holds that site safe; the first report site
 * (:141) is chained `.then(…).catch(…)` and would survive a throw.
 */
export const hostScreenUnreadReplySchema = z.unknown()

/** One decoded catalog icon: the members MobileRepoIcon reads, with the rest passed through. */
export type MobileHostRepoIcon = NonNullable<
  z.output<typeof hostRepoCatalogSchema>[number]['repoIcon']
>

/** What MobileRepoIcon renders: a decoded catalog icon, or the `RepoIcon` a worktree row carries. */
export type MobileRenderableRepoIcon = MobileHostRepoIcon | RepoIcon
