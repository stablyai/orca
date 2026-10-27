import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import { linearIssueRowSchema } from './task-item-detail-reply-schema'

// Keep guarded identity fields optional; labels are the unguarded exception shared by both provider editors.

const itemText = (name: string) => salvagedOptional(name, z.string())
const itemCount = (name: string) => salvagedOptional(name, z.number())

const workItemRow = z.looseObject({
  id: itemText('id'),
  type: itemText('type'),
  number: itemCount('number'),
  title: itemText('title'),
  state: itemText('state'),
  url: itemText('url'),
  updatedAt: itemText('updatedAt'),
  // Label editors call filter unguarded; drop rows without the list.
  labels: salvagingArray(z.string()),
  // Explicit null author renders differently from unreported author.
  author: salvagedOptional('author', z.string().nullable())
})

// items is mapped unguarded; banner fields retain their own per-member checks and partial-success data.
export const taskGitHubWorkItemListSchema = z.looseObject({
  items: salvagingArray(workItemRow),
  sources: z.unknown().optional(),
  errors: z.unknown().optional(),
  issueSourceFellBack: z.unknown().optional()
})

// GitLab can return items with an in-band not_found error; require items without making optional error fatal.
export const taskGitLabWorkItemListSchema = z.looseObject({
  items: salvagingArray(workItemRow),
  error: salvagedOptional(
    'error',
    z.looseObject({ type: itemText('type'), message: itemText('message') })
  )
})

// Linear search returns arrays and list returns items envelopes; both reuse the detail row’s mapping/sort requirements.
export const taskLinearIssueListSchema = z.union([
  salvagingArray(linearIssueRowSchema),
  z.looseObject({ items: salvagingArray(linearIssueRowSchema) }).transform((reply) => reply.items)
])

// Preserve null when no work item matches; use the same provider row as lists, whose number supplies GitLab iid params.
export const taskWorkItemLookupSchema = workItemRow.nullable()
