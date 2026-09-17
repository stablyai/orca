import { z } from 'zod'
import type { GitHubProjectOwnerType } from '../../../src/shared/github/project-types'
import { hostUnionArms, salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import {
  assignableUserListSchema,
  detailCheckListSchema,
  detailCommentListSchema,
  detailFileListSchema,
  reviewSummaryListSchema
} from './task-provider-entity-reply-schema'

// The sixteen `github.project.*` replies the Projects board reads. Every one of them is an
// accepted result carrying its own `{ ok, error }` envelope, published by
// src/main/runtime/rpc/methods/github-project-methods.ts and typed in
// src/shared/github/project-result-types.ts.
//
// Two shapes appear here, and which one a reply gets is decided by its consumer, not by the host:
//
//   - a discriminated union, where the consumer reads a member off BOTH arms without a guard
//     (`result.error.message` on the refusal arm and the payload on the success arm). `ok` is
//     load-bearing there, so an envelope without it is an incompatible reply rather than the
//     property-read TypeError main threw;
//   - a flat passthrough object, where the consumer guards every member it reads
//     (`result.error?.message ?? '...'`, `result.labels ?? []`). Nothing is required there beyond
//     the container, because requiring a member the consumer already defaults would refuse a reply
//     main rendered.
//
// Required members are only ever ones a recorded golden shows the host sending AND a consumer
// reads unguarded. Nothing deeper is declared: the project table's rows, for instance, have no
// recorded row to check a deeper requirement against, so requiring one would be a claim about the
// wire that this corpus cannot support.

/**
 * `owner`/`ownerType`/`number` compose the persisted project key, so every row carries them.
 *
 * CLOSED, and the one enum here that is. The two arms are GitHubProjectOwnerType verbatim
 * (src/shared/github/project-types.ts:8), which is the type the handler's own params and results
 * are declared in — not mobile's restatement of it. It stays closed because a decoded `ownerType`
 * is echoed straight back into the params of the next project call
 * (mobile-tasks-github-project-pickers.tsx:227, use-mobile-tasks-project-loading-actions.tsx:75,
 * :110, :269), and remote-wire-compatibility.md rule 4 forbids letting a fallback shape a param
 * the host reads back. An unknown arm therefore drops its row rather than inventing an owner type.
 * The corpus exercises `'organization'` (`tk-project-board-load`); `'user'` is unexercised but
 * inside the set, so no reply can drop on it.
 */
// Pinned to the host's own union through hostUnionArms: an arm added or dropped host-side fails tsc.
export const PROJECT_OWNER_TYPE = hostUnionArms<GitHubProjectOwnerType>({
  organization: true,
  user: true
})

const projectMessage = (name: string) => salvagedOptional(name, z.string())
const projectCount = (name: string) => salvagedOptional(name, z.number())

/** The refusal arm's message, read unguarded as `result.error.message`. */
const requiredProjectError = z
  .looseObject({ message: projectMessage('message') })
  .transform((error) => ({
    ...error,
    message: error.message ?? ''
  }))

/** The refusal arm's message where the consumer already spells `?? 'Failed to …'`. */
const optionalProjectError = salvagedOptional(
  'error',
  z.looseObject({ message: projectMessage('message') })
)

/** `ok` where the consumer tests it rather than switching on it: absent still reads as refused. */
const optionalOk = salvagedOptional('ok', z.boolean())

/**
 * One accessible project.
 *
 * `owner` is required because githubProjectIdentityKey calls `.toLowerCase()` on it
 * (src/shared/github/project-identity.ts:13) for every row the picker stores or compares, and
 * `ownerType`/`number` are the rest of that key. `title` is required for the same reason one step
 * later: the picker's search spells `project.title.toLowerCase()` with no guard
 * (use-mobile-tasks-provider-view-projection.tsx:213), it is non-optional on GitHubProjectSummary
 * (src/shared/github/project-types.ts:200-209), and the recorded reply carries it. A row without
 * any of the four is dropped rather than failing the list, which keeps the banner and the
 * remaining projects.
 *
 * `id`, `url` and `source` stay undeclared: the recorded reply (`tk-project-board-load`,
 * `github.project.listAccessible#1`) carries none of them, so requiring what the shared type
 * declares would refuse main's own fixture.
 */
const projectSummary = z.looseObject({
  owner: z.string(),
  ownerType: z.enum(PROJECT_OWNER_TYPE),
  number: z.number(),
  title: z.string(),
  host: projectMessage('host')
})

/**
 * The accessible-project list.
 *
 * `projects` is required on the success arm: use-mobile-tasks-project-loading-actions.tsx:62 hands
 * it straight to `setGithubProjects`, and `partialFailures` is not, because :64 spells `?? []`.
 * `error.message` is required on the refusal arm because :59 throws it unguarded.
 */
export const taskProjectAccessibleListSchema = z.union([
  z.looseObject({
    ok: z.literal(true),
    projects: salvagingArray(projectSummary),
    partialFailures: salvagedOptional(
      'partialFailures',
      salvagingArray(
        z.looseObject({ owner: projectMessage('owner'), message: projectMessage('message') })
      )
    )
  }),
  z.looseObject({ ok: z.literal(false), error: requiredProjectError })
])

/**
 * A project's views.
 *
 * `views` is required: :84 publishes it and :85 returns it, and :191/:196/:210/:220 run `find` and
 * `filter` over the same array with no guard. A view needs the `id` the selection is committed
 * under (:225 → githubProjectSettings.lastViewByProject), so a row without one drops.
 *
 * `layout` is a plain string, not an enum. Every reader is an equality test against
 * `'TABLE_LAYOUT'` (:196/:204/:210/:220), so a layout arm this build has not heard of already
 * reads as "not supported" — closing the set would instead drop the row and change the count the
 * "no supported views" copy is decided by. That is remote-wire-compatibility.md rule 4.
 */
export const taskProjectViewListSchema = z.union([
  z.looseObject({
    ok: z.literal(true),
    views: salvagingArray(
      z.looseObject({
        id: z.string(),
        number: projectCount('number'),
        name: projectMessage('name'),
        layout: projectMessage('layout')
      })
    )
  }),
  z.looseObject({ ok: z.literal(false), error: requiredProjectError })
])

/**
 * The board table.
 *
 * `data` and `data.selectedView` are required because :126 reads `data.selectedView.filter` and
 * :128-:137 read four more members off it, all unguarded — a reply without the container was a
 * property read on undefined. `project.id` is required for the same reason at
 * use-mobile-tasks-project-metadata-actions.tsx:160/:172, which sends it as `projectId` on every field
 * mutation.
 *
 * Nothing inside `selectedView` or `rows` is required. The recorded table
 * (`tk-project-board-load`, `github.project.viewTable#1`) carries a `project` with no `owner`,
 * `ownerType` or `url` and an empty `rows`, so this corpus has no evidence for a deeper claim.
 */
export const taskProjectViewTableSchema = z.union([
  z.looseObject({
    ok: z.literal(true),
    data: z.looseObject({
      project: z.looseObject({ id: z.string() }),
      selectedView: z.looseObject({
        id: projectMessage('id'),
        number: projectCount('number'),
        name: projectMessage('name'),
        layout: projectMessage('layout'),
        filter: projectMessage('filter')
      }),
      rows: salvagedOptional('rows', salvagingArray(z.looseObject({ id: z.string() })))
    })
  }),
  z.looseObject({
    ok: z.literal(false),
    error: requiredProjectError,
    totalCount: projectCount('totalCount')
  })
])

/**
 * A pasted project URL or `owner/number`, resolved.
 *
 * `owner`, `ownerType` and `number` are required:
 * use-mobile-tasks-project-loading-actions.tsx:267-:272 forward all three into
 * `selectGitHubProject`, which puts them in the key and in the next `github.project.listViews`
 * params. `ownerType` is therefore a CLOSED enum with no fallback — it is echoed into a param, and
 * remote-wire-compatibility.md rule 4 forbids a reply-schema fallback from shaping one. The arm
 * set is genuinely closed host-side: project-view-listing.ts:23 answers `validation_error` for any
 * other value, so degrading an unknown arm would only put a value the host refuses on the wire.
 *
 * `title` is optional because no mobile consumer reads it. `host` is optional because
 * use-mobile-tasks-project-loading-actions.tsx:271 coalesces it (`result.host ?? parsed.host`),
 * and `viewNumber` because :190 tests `typeof options.viewNumber === 'number'` before using it.
 */
export const taskProjectRefSchema = z.union([
  z.looseObject({
    ok: z.literal(true),
    owner: z.string(),
    ownerType: z.enum(PROJECT_OWNER_TYPE),
    number: z.number(),
    title: projectMessage('title'),
    host: projectMessage('host'),
    viewNumber: projectCount('viewNumber')
  }),
  z.looseObject({ ok: z.literal(false), error: requiredProjectError })
])

/**
 * A board row's detail pane.
 *
 * `details` is required: use-mobile-tasks-project-detail-loading.tsx:110-:121 reads eleven members
 * off it, each defaulted but the container itself never guarded. `error.message` is required
 * because :102 throws it.
 *
 * `item.reviewDecision` is nullable AND optional and stays that way. :121 forwards it verbatim
 * into `projectRowDetail`, where `null` ("reviewed, no decision") and absent ("this host does not
 * report one") are different states — collapsing either into the other with a `??` here would be
 * the null-collapse the session domain shipped and had caught two review rounds later.
 */
export const taskProjectRowDetailSchema = z.union([
  z.looseObject({
    ok: z.literal(true),
    details: z.looseObject({
      body: projectMessage('body'),
      comments: salvagedOptional('comments', detailCommentListSchema),
      item: salvagedOptional(
        'item',
        z.looseObject({
          labels: salvagedOptional('labels', salvagingArray(z.string())),
          reviewDecision: salvagedOptional('reviewDecision', z.string().nullable()),
          reviewRequests: salvagedOptional('reviewRequests', assignableUserListSchema),
          latestReviews: salvagedOptional('latestReviews', reviewSummaryListSchema)
        })
      ),
      assignees: salvagedOptional('assignees', salvagingArray(z.string())),
      headSha: projectMessage('headSha'),
      baseSha: projectMessage('baseSha'),
      pullRequestId: projectMessage('pullRequestId'),
      checks: salvagedOptional('checks', detailCheckListSchema),
      files: salvagedOptional('files', detailFileListSchema)
    })
  }),
  z.looseObject({ ok: z.literal(false), error: requiredProjectError })
])

/**
 * The repo label list.
 *
 * Flat, not a union: use-mobile-tasks-project-metadata-loading.tsx:53 spells
 * `result.error?.message ?? 'Failed to load labels'` and :55 spells `result.labels ?? []`, so
 * every member is already defaulted and an envelope with no `ok` still reads as refused. What the
 * schema adds is the container and the element type — a `labels` that is not an array of strings
 * reached the label picker as rendered garbage.
 */
export const taskProjectLabelListSchema = z.looseObject({
  ok: optionalOk,
  labels: salvagedOptional('labels', salvagingArray(z.string())),
  error: optionalProjectError
})

/** The assignable-user list, guarded the same way at :105-:110. The row is
 *  `assignableUserListSchema`, the same entity the item sheet's reviewer picker decodes: `login` is
 *  what both key on, and `name`/`avatarUrl` keep their explicit `null`. */
export const taskProjectAssignableUserListSchema = z.looseObject({
  ok: optionalOk,
  users: salvagedOptional('users', assignableUserListSchema),
  error: optionalProjectError
})

/** The repo issue types, guarded the same way at :159-:164. `id` is the mutation's own param
 *  (use-mobile-tasks-project-metadata-actions.tsx:240), so a row without one cannot be applied. */
export const taskProjectIssueTypeListSchema = z.looseObject({
  ok: optionalOk,
  types: salvagedOptional(
    'types',
    salvagingArray(z.looseObject({ id: z.string(), name: projectMessage('name') }))
  ),
  error: optionalProjectError
})

/**
 * The five board mutations whose reply is only a verdict: the issue and pull-request metadata
 * writes, the issue-type write, and the field set/clear pair.
 *
 * Every consumer tests `result.ok === false` and then `result.error?.message ?? '…'`
 * (use-mobile-tasks-project-metadata-actions.tsx:63/:182/:245 and
 * use-mobile-tasks-project-workspace-comment-actions.tsx:142), so nothing but the container is
 * required. The container is the change: `project.update-metadata`'s `b2` seed answers
 * `result: null`, which main read as `null.ok` and #20563 left recorded as a TypeError. It is now
 * named as an incompatible `github.project.updateIssueBySlug` reply instead.
 */
export const taskProjectMutationStatusSchema = z.looseObject({
  ok: optionalOk,
  error: optionalProjectError
})

/**
 * The added comment.
 *
 * `comment` is optional because :225 gates on it before appending. It carries `id` and `body`
 * because the thread renderer keys and prints them, and because the recorded reply
 * (`tk-project-row-comments-issue`) carries both — `id` as a NUMBER there, which is why the
 * schema takes either rather than the string the mobile type leads with.
 */
export const taskProjectCommentWriteSchema = z.looseObject({
  ok: optionalOk,
  comment: salvagedOptional(
    'comment',
    z.looseObject({
      id: z.union([z.string(), z.number()]),
      body: projectMessage('body'),
      author: projectMessage('author'),
      createdAt: projectMessage('createdAt')
    })
  ),
  error: optionalProjectError
})

/**
 * The comment edit and delete verdicts.
 *
 * `error` is a string OR an envelope, because both consumers read it that way
 * (use-mobile-tasks-project-workspace-comment-actions.tsx:271 and
 * use-mobile-tasks-project-thread-reply-actions.tsx:62 both branch on `typeof result.error ===
 * 'string'`). Declaring only the envelope would salvage the string away and replace a host message
 * the user has always seen with this app's fallback copy.
 */
export const taskProjectCommentMutationSchema = z.looseObject({
  ok: optionalOk,
  error: salvagedOptional(
    'error',
    z.union([z.string(), z.looseObject({ message: projectMessage('message') })])
  )
})
