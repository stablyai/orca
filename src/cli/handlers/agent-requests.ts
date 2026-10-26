import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'
import { listAgentRequests, type AgentRequestScope } from '../agent-request-inventory'
import { answerAgentRequest } from '../agent-request-answer'
import { readAgentRequestAnswerFile } from '../agent-request-answer-file'

/** Requires explicit session/workspace selectors and refuses ambient focus or wildcard targets. */
function scope({ flags }: HandlerContext): AgentRequestScope {
  const worktree = getRequiredStringFlag(flags, 'worktree')
  if (['active', 'current', 'all', '*'].includes(worktree)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Native requests require an explicit workspace; focus and all-workspace selectors are refused.'
    )
  }
  return {
    worktree,
    sessionId: getRequiredStringFlag(flags, 'session'),
    ...(flags.has('turn') ? { turnItemId: getRequiredStringFlag(flags, 'turn') } : {})
  }
}

/** Prints current scoped prompts and refuses item IDs outside the authoritative snapshot. */
const read: CommandHandler = async (context) => {
  const target = scope(context)
  const inventory = await listAgentRequests(context.client, target)
  const itemId = getOptionalStringFlag(context.flags, 'item')
  const requests =
    itemId === undefined
      ? inventory.requests
      : inventory.requests.filter((request) => request.itemId === itemId)
  if (itemId !== undefined && requests.length !== 1) {
    throw new RuntimeClientError(
      'agent_request_not_current',
      'This item is not a current request in the explicit session/workspace/turn.'
    )
  }
  printResult(
    {
      id: 'agent-requests',
      ok: true,
      _meta: { runtimeId: inventory.runtimeId },
      result: { ...inventory, requests, resumed: 'unverified' }
    },
    context.json,
    (value) => JSON.stringify(value, null, 2)
  )
}

export const AGENT_REQUEST_HANDLERS: Record<string, CommandHandler> = {
  'agent requests list': read,
  /** Requires a named item before performing the same authoritative scoped read. */
  'agent requests get': async (context) => {
    getRequiredStringFlag(context.flags, 'item')
    await read(context)
  },
  /** Reads exact answers from a file and prints their receipt without interpreting prompt text. */
  'agent requests answer': async (context) => {
    const target = scope(context)
    const input = await readAgentRequestAnswerFile(
      getRequiredStringFlag(context.flags, 'request-file')
    )
    const response = await answerAgentRequest(
      context.client,
      target,
      input,
      getOptionalStringFlag(context.flags, 'retry')
    )
    printResult(response, context.json, (value) => JSON.stringify(value, null, 2))
  }
}
