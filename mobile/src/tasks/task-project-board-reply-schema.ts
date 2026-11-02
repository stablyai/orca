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

// Require only unguarded consumer reads: discriminated outcomes need ok, while guarded envelopes may omit it.

// Owner type round-trips in project params; reject unknown arms instead of inventing a host-rejected token.
export const PROJECT_OWNER_TYPE = hostUnionArms<GitHubProjectOwnerType>({
  organization: true,
  user: true
})

const projectMessage = (name: string) => salvagedOptional(name, z.string())
const projectCount = (name: string) => salvagedOptional(name, z.number())

const requiredProjectError = z
  .looseObject({ message: projectMessage('message') })
  .transform((error) => ({
    ...error,
    message: error.message ?? ''
  }))

const optionalProjectError = salvagedOptional(
  'error',
  z.looseObject({ message: projectMessage('message') })
)

const optionalOk = salvagedOptional('ok', z.boolean())

// Project identity and searchable title are read unguarded; optional metadata must not reject older host rows.
const projectSummary = z.looseObject({
  owner: z.string(),
  ownerType: z.enum(PROJECT_OWNER_TYPE),
  number: z.number(),
  title: z.string(),
  host: projectMessage('host')
})

// Success publishes projects directly and refusal reads error.message unguarded; partial failures have a fallback.
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

// Views need ids for selection; keep layout open so newer host layouts reach existing unsupported-view handling.
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

// Require selectedView’s container and project.id for mutations; guarded view/row fields remain optional.
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

// Resolved owner/type/number become project keys and RPC params; ownerType must stay within host validation.
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

// Details and refusal message are read unguarded; retain reviewDecision null separately from absent.
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

// Labels and refusal messages have fallbacks; validate their shapes without requiring guarded members.
export const taskProjectLabelListSchema = z.looseObject({
  ok: optionalOk,
  labels: salvagedOptional('labels', salvagingArray(z.string())),
  error: optionalProjectError
})

export const taskProjectAssignableUserListSchema = z.looseObject({
  ok: optionalOk,
  users: salvagedOptional('users', assignableUserListSchema),
  error: optionalProjectError
})

export const taskProjectIssueTypeListSchema = z.looseObject({
  ok: optionalOk,
  types: salvagedOptional(
    'types',
    salvagingArray(z.looseObject({ id: z.string(), name: projectMessage('name') }))
  ),
  error: optionalProjectError
})

// Mutation consumers guard ok/error but assume an envelope; reject null before property access.
export const taskProjectMutationStatusSchema = z.looseObject({
  ok: optionalOk,
  error: optionalProjectError
})

// Missing comments preserve caller behavior; returned rows need body and string-or-number id for the timeline.
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

// Consumers accept string and object errors; preserve both so host messages are not replaced by fallback copy.
export const taskProjectCommentMutationSchema = z.looseObject({
  ok: optionalOk,
  error: salvagedOptional(
    'error',
    z.union([z.string(), z.looseObject({ message: projectMessage('message') })])
  )
})
