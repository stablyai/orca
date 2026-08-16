import { z } from 'zod'
import { OptionalString } from '../schemas'

export const PlaneListFilter = z.enum(['assigned', 'created', 'all', 'completed', 'open'])

const PlaneStateGroup = z.enum(['backlog', 'unstarted', 'started', 'completed', 'cancelled'])
const PlanePriority = z.enum(['urgent', 'high', 'medium', 'low', 'none'])

export const PlaneIssueQuery = z.object({
  preset: PlaneListFilter.optional(),
  query: OptionalString,
  projectId: OptionalString,
  projectIds: z.array(z.string()).optional(),
  stateGroup: PlaneStateGroup.optional(),
  stateGroups: z.array(PlaneStateGroup).optional(),
  stateId: OptionalString,
  stateIds: z.array(z.string()).optional(),
  priority: PlanePriority.optional(),
  priorities: z.array(PlanePriority).optional(),
  assigneeId: OptionalString,
  assigneeIds: z.array(z.string()).optional(),
  labelId: OptionalString,
  labelIds: z.array(z.string()).optional(),
  cycleId: OptionalString,
  moduleId: OptionalString,
  typeId: OptionalString,
  estimatePoint: z
    .union([z.string(), z.number()])
    .transform((value) =>
      typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))
        ? Number(value)
        : value
    )
    .optional(),
  orderBy: z
    .enum([
      '-updated_at',
      'updated_at',
      '-created_at',
      'created_at',
      'priority',
      '-priority',
      'state',
      '-state',
      'name',
      '-name',
      'sort_order',
      '-sort_order'
    ])
    .optional()
})
