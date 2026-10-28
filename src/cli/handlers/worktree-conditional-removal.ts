import {
  ConditionalWorktreeRemoval,
  type ConditionalWorktreeRemovalResult
} from '../../shared/rpc-contract/conditional-worktree-removal'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'

export const WORKTREE_CONDITIONAL_REMOVAL_HANDLERS: Record<string, CommandHandler> = {
  'worktree removal-capabilities': async ({ client, json }) => {
    const result = await client.call('worktree.removalCapabilities', {})
    printResult(result, json, (value) => JSON.stringify(value))
  },
  'worktree rm-idle': async ({ flags, client, json }) => {
    const expectedJson = getRequiredStringFlag(flags, 'expect-json')
    if (expectedJson.length > 65536) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Expectation exceeds the bounded request size.'
      )
    }
    let expected: unknown
    try {
      expected = JSON.parse(expectedJson)
    } catch {
      throw new RuntimeClientError('invalid_argument', 'Invalid expectation JSON.')
    }
    const request = ConditionalWorktreeRemoval.safeParse({
      requestId: getRequiredStringFlag(flags, 'request-id'),
      expected
    })
    if (!request.success) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Exact workspace and Git identity are required.'
      )
    }
    // Older hosts must refuse; never translate this into ordinary worktree.rm.
    const result = await client.call<ConditionalWorktreeRemovalResult>(
      'worktree.removeIfIdle',
      request.data
    )
    if (result.result.status !== 'removed') {
      throw new RuntimeClientError(
        `worktree_idle_removal_${result.result.reason}`,
        result.result.detail
      )
    }
    printResult(result, json, (value) => JSON.stringify(value))
  }
}
