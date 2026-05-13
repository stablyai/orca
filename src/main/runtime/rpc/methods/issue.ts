import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

function requiredNonBlankString(message: string) {
  return requiredString(message).refine((value) => value.trim().length > 0, { message })
}

const IssueCreate = z
  .object({
    provider: z.enum(['github', 'linear']),
    repo: z.string().optional(),
    team: z.string().optional(),
    title: requiredNonBlankString('Missing --title'),
    body: requiredNonBlankString('Missing --body')
  })
  .superRefine((params, ctx) => {
    if (params.provider === 'github') {
      if (!params.repo?.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['repo'],
          message: 'GitHub issue creation requires --repo'
        })
      }
      if (params.team?.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['team'],
          message: 'GitHub issue creation uses --repo, not --team'
        })
      }
      return
    }
    if (!params.team?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['team'],
        message: 'Linear issue creation requires --team'
      })
    }
    if (params.repo?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['repo'],
        message: 'Linear issue creation uses --team, not --repo'
      })
    }
  })

export const ISSUE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'issue.create',
    params: IssueCreate,
    handler: async (params, { runtime }) => await runtime.createIssue(params)
  })
]
