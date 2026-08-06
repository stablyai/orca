import { z } from 'zod'
import {
  LINEAR_ISSUE_ATTRIBUTE_FILTER_ID_MAX_LENGTH,
  LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_LABEL_IDS,
  LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_PRIORITIES,
  LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS
} from '../../../../shared/linear-issue-attribute-filter'

// Why: keep ListIssues param validation co-located with shared limits without
// pushing linear.ts past the max-lines ratchet.
const LinearAttributeFilterId = z
  .string()
  .trim()
  .min(1)
  .max(LINEAR_ISSUE_ATTRIBUTE_FILTER_ID_MAX_LENGTH)

export const LinearIssueAttributeFilterSchema = z
  .object({
    stateIds: z.array(LinearAttributeFilterId).max(LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS),
    priorities: z
      .array(z.number().int().min(0).max(4))
      .max(LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_PRIORITIES),
    assignee: z.union([
      z.object({ kind: z.literal('unassigned') }).strict(),
      z
        .object({
          kind: z.literal('user'),
          id: LinearAttributeFilterId
        })
        .strict(),
      z.null()
    ]),
    labelIds: z.array(LinearAttributeFilterId).max(LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_LABEL_IDS)
  })
  .strict()
