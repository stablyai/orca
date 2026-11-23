import * as z from 'zod'
import { salvagedOptional, salvagingArray } from '../../../../../src/shared/validation/zod-salvage'

// Required identity fields reject unusable rows; optional fields salvage older-host replies.

const text = (name: string) => salvagedOptional(name, z.string())

const textOrEmpty = (name: string) => text(name).transform((value) => value ?? '')

const clickUpWorkspaceRow = z.looseObject({
  id: z.string(),
  name: z.string(),
  color: text('color')
})

export const clickUpConnectionStatusSchema = z.looseObject({
  connected: z.boolean(),
  workspaces: salvagedOptional('workspaces', salvagingArray(clickUpWorkspaceRow)),
  selectedWorkspaceId: salvagedOptional('selectedWorkspaceId', z.string().nullable()),
  credentialError: text('credentialError'),
  viewer: z.unknown().optional()
})

const clickUpUserRow = z.looseObject({
  id: z.string(),
  username: textOrEmpty('username'),
  email: textOrEmpty('email'),
  avatarUrl: text('avatarUrl')
})

const clickUpStatusRow = z.looseObject({
  name: z.string(),
  color: textOrEmpty('color'),
  type: salvagedOptional('type', z.enum(['open', 'custom', 'done', 'closed'])).transform(
    (value) => value ?? 'custom'
  ),
  orderIndex: salvagedOptional('orderIndex', z.number()).transform((value) => value ?? 0)
})

const clickUpNamed = z.looseObject({ id: z.string(), name: z.string() })

export const clickUpTaskRowSchema = z.looseObject({
  id: z.string(),
  customId: salvagedOptional('customId', z.string().nullable()).transform((value) => value ?? null),
  name: z.string(),
  descriptionMarkdown: textOrEmpty('descriptionMarkdown'),
  status: clickUpStatusRow,
  priority: salvagedOptional(
    'priority',
    z.looseObject({ id: z.string(), label: z.string(), color: textOrEmpty('color') }).nullable()
  ).transform((value) => value ?? null),
  assignees: salvagedOptional('assignees', salvagingArray(clickUpUserRow)).transform(
    (value) => value ?? []
  ),
  creator: salvagedOptional('creator', clickUpUserRow.nullable()).transform(
    (value) => value ?? null
  ),
  tags: salvagedOptional('tags', salvagingArray(z.string())).transform((value) => value ?? []),
  url: z.string(),
  createdAt: textOrEmpty('createdAt'),
  updatedAt: z.string(),
  dueAt: salvagedOptional('dueAt', z.string().nullable()).transform((value) => value ?? null),
  list: clickUpNamed,
  folder: salvagedOptional('folder', clickUpNamed.nullable()).transform((value) => value ?? null),
  spaceId: textOrEmpty('spaceId'),
  workspaceId: textOrEmpty('workspaceId'),
  parentId: salvagedOptional('parentId', z.string().nullable()).transform((value) => value ?? null)
})

export const clickUpTaskPageSchema = z.looseObject({
  tasks: salvagingArray(clickUpTaskRowSchema),
  nextPage: salvagedOptional('nextPage', z.number().int().nonnegative().nullable()).transform(
    (value) => value ?? null
  )
})

export const clickUpTaskListSchema = salvagingArray(clickUpTaskRowSchema)

// A host that has no task returns null, which reads as not found rather than an incompatible reply.
export const clickUpTaskOrNullSchema = clickUpTaskRowSchema.nullable()

export const clickUpCommentListSchema = salvagingArray(
  z.looseObject({
    id: z.string(),
    body: textOrEmpty('body'),
    createdAt: text('createdAt'),
    author: salvagedOptional('author', clickUpUserRow.nullable()).transform(
      (value) => value ?? null
    )
  })
)

export const clickUpStatusListSchema = salvagingArray(clickUpStatusRow)

// Writes report refusals in band; the error text is the host's already-localizable message.
export const clickUpWriteResultSchema = z.looseObject({
  ok: z.boolean(),
  id: salvagedOptional('id', z.string()),
  error: text('error')
})
