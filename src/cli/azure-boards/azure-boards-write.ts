import { AZURE_BOARDS_AGENT_WRITE_RUNTIME_CAPABILITY } from '../../shared/azure-devops/azure-boards-agent-types'
import type { AzureDevOpsWorkItem } from '../../shared/azure-devops/boards-types'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { resolveAzureBoardsRepo } from './azure-boards-target'

/** Refuses with a preview unless --confirm: an agent must show the user the change first. */
export function requireAzureDevOpsWriteConfirmation(
  context: HandlerContext,
  preview: string
): void {
  if (context.flags.get('confirm') !== true) {
    throw new RuntimeClientError(
      'confirmation_required',
      `${preview}\nNothing was changed. Show this to the user and rerun with --confirm once they approve.`
    )
  }
}

/** The preview shows the revision being approved; --expect-rev holds the write to it. */
async function previewWithRevision(
  context: HandlerContext,
  repo: string,
  id: number,
  change: string
): Promise<number | undefined> {
  const expectedRev = getOptionalPositiveIntegerFlag(context.flags, 'expect-rev')
  if (context.flags.get('confirm') === true) {
    return expectedRev
  }
  const current = await context.client.call<AzureDevOpsWorkItem | null>('azureBoards.workItem', {
    repo,
    id
  })
  const item = current.result
  const now = item
    ? `Now: ${item.state}, ${item.assignedTo?.displayName ?? 'unassigned'} (rev ${item.rev}).`
    : 'The item could not be read.'
  requireAzureDevOpsWriteConfirmation(
    context,
    `${change}\n${now}${item ? `\nRerun with --confirm --expect-rev ${item.rev} so a later edit refuses the write.` : ''}`
  )
  return expectedRev
}

function formatUpdated(item: AzureDevOpsWorkItem): string {
  return `${item.workItemType} ${item.id}: ${item.state}, ${item.assignedTo?.displayName ?? 'unassigned'}`
}

export function azureBoardsWriteHandlers(
  workItemId: (context: HandlerContext) => number
): Record<string, CommandHandler> {
  const writeTarget = (context: HandlerContext): Promise<string> =>
    resolveAzureBoardsRepo(context, AZURE_BOARDS_AGENT_WRITE_RUNTIME_CAPABILITY)
  return {
    'azure-boards comment add': async (context) => {
      const id = workItemId(context)
      const text = getRequiredStringFlag(context.flags, 'body').trim()
      if (!text) {
        throw new RuntimeClientError('invalid_argument', 'The comment body cannot be blank.')
      }
      requireAzureDevOpsWriteConfirmation(context, `Would comment on work item ${id}:\n${text}`)
      const repo = await writeTarget(context)
      const response = await context.client.call<{ commentId: number }>('azureBoards.addComment', {
        repo,
        id,
        text,
        confirm: true
      })
      printResult(
        response,
        context.json,
        (r) => `Posted comment ${r.commentId} on work item ${id}.`
      )
    },
    'azure-boards state set': async (context) => {
      const id = workItemId(context)
      const state = getRequiredStringFlag(context.flags, 'to').trim()
      const repo = await writeTarget(context)
      const expectedRev = await previewWithRevision(
        context,
        repo,
        id,
        `Would move work item ${id} to "${state}".`
      )
      const response = await context.client.call<AzureDevOpsWorkItem>('azureBoards.setState', {
        repo,
        id,
        state,
        expectedRev,
        confirm: true
      })
      printResult(response, context.json, formatUpdated)
    },
    'azure-boards assignee set': async (context) => {
      const id = workItemId(context)
      const me = context.flags.get('me') === true
      const to = getOptionalStringFlag(context.flags, 'to')?.trim()
      if (me === Boolean(to)) {
        throw new RuntimeClientError(
          'invalid_argument',
          'Pass exactly one of --to <email> or --me.'
        )
      }
      const assignee = me ? '@me' : (to ?? '')
      const repo = await writeTarget(context)
      const expectedRev = await previewWithRevision(
        context,
        repo,
        id,
        `Would assign work item ${id} to ${me ? 'you' : assignee}.`
      )
      const response = await context.client.call<AzureDevOpsWorkItem>('azureBoards.setAssignee', {
        repo,
        id,
        assignee,
        expectedRev,
        confirm: true
      })
      printResult(response, context.json, formatUpdated)
    },
    'azure-boards assignee clear': async (context) => {
      const id = workItemId(context)
      const repo = await writeTarget(context)
      const expectedRev = await previewWithRevision(
        context,
        repo,
        id,
        `Would unassign work item ${id}.`
      )
      const response = await context.client.call<AzureDevOpsWorkItem>('azureBoards.setAssignee', {
        repo,
        id,
        assignee: null,
        expectedRev,
        confirm: true
      })
      printResult(response, context.json, formatUpdated)
    }
  }
}
