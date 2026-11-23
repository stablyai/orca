import { AZURE_DEVOPS_PR_REVIEW_WRITE_RUNTIME_CAPABILITY } from '../../shared/azure-devops/azure-devops-pr-review-types'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { resolveAzureBoardsRepo } from './azure-boards-target'

const VOTES: Record<string, 10 | 5 | 0 | -5> = {
  approve: 10,
  'approve-with-suggestions': 5,
  reset: 0,
  'wait-for-author': -5
}

/** Refuses with a preview unless --confirm: an agent must show the user the write first. */
function requireConfirmation(context: HandlerContext, preview: string): void {
  if (context.flags.get('confirm') !== true) {
    throw new RuntimeClientError(
      'confirmation_required',
      `${preview}\nNothing was posted. Show this to the user and rerun with --confirm once they approve.`
    )
  }
}

export function azureDevOpsPrWriteHandlers(
  prId: (context: HandlerContext) => number
): Record<string, CommandHandler> {
  return {
    'azure-devops pr comment': async (context) => {
      const id = prId(context)
      const body = getRequiredStringFlag(context.flags, 'body').trim()
      const threadId = getOptionalPositiveIntegerFlag(context.flags, 'thread')
      const filePath = getOptionalStringFlag(context.flags, 'file')?.trim() || undefined
      const line = getOptionalPositiveIntegerFlag(context.flags, 'line')
      if (!body) {
        throw new RuntimeClientError('invalid_argument', 'The comment body cannot be blank.')
      }
      if (threadId !== undefined && filePath) {
        throw new RuntimeClientError('invalid_argument', 'Use --thread or --file, not both.')
      }
      if (line !== undefined && !filePath) {
        throw new RuntimeClientError('invalid_argument', '--line needs --file.')
      }
      const where =
        threadId !== undefined
          ? `a reply in thread ${threadId}`
          : filePath
            ? `a new thread on ${filePath}${line ? `:${line}` : ''}`
            : 'a new thread'
      requireConfirmation(context, `Would post ${where} on PR ${id}:\n${body}`)
      const repo = await resolveAzureBoardsRepo(
        context,
        AZURE_DEVOPS_PR_REVIEW_WRITE_RUNTIME_CAPABILITY
      )
      const response = await context.client.call<{ threadId: number; commentId: number }>(
        'azureDevOps.prComment',
        { repo, id, body, threadId, filePath, line, confirm: true }
      )
      printResult(
        response,
        context.json,
        (result) => `Posted comment ${result.commentId} in thread ${result.threadId} on PR ${id}.`
      )
    },
    'azure-devops pr vote': async (context) => {
      const id = prId(context)
      const name = getRequiredStringFlag(context.flags, 'vote').trim()
      const vote = VOTES[name]
      if (vote === undefined) {
        throw new RuntimeClientError(
          'invalid_argument',
          '--vote must be approve, approve-with-suggestions, wait-for-author or reset. Reject is not available.'
        )
      }
      requireConfirmation(context, `Would set your vote on PR ${id} to ${name} (${vote}).`)
      const repo = await resolveAzureBoardsRepo(
        context,
        AZURE_DEVOPS_PR_REVIEW_WRITE_RUNTIME_CAPABILITY
      )
      const response = await context.client.call<{ vote: number }>('azureDevOps.prVote', {
        repo,
        id,
        vote,
        confirm: true
      })
      printResult(response, context.json, (result) => `Your vote on PR ${id} is ${result.vote}.`)
    }
  }
}
