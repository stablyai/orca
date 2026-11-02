import { createSessionSearchClient } from '../../shared/ai-vault-search-client'
import type { RuntimeRpcSuccess } from '../../shared/runtime-rpc-envelope'
import {
  formatSessionSearchResponse,
  formatSessionSearchStatus
} from '../agent-session-search-format'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime/types'
import { parseSearchCommand } from '../search-command-arguments'

export const MALFORMED_CURSOR_MESSAGE =
  'The host did not recognise that --cursor value. Cursors belong to one query on one host; re-run the search without --cursor.'

// Reuse contract compatibility and exposure policy: paired runtimes are relay callers.
function createCliSessionSearch(client: RuntimeClient) {
  let lastEnvelope: RuntimeRpcSuccess<unknown> | undefined
  const search = createSessionSearchClient(
    async (method, params) => {
      lastEnvelope = await client.call(method, params)
      return lastEnvelope.result
    },
    client.isRemote ? 'relay' : 'runtime'
  )
  // A synthesized refusal has no runtime envelope; do not claim an unobserved runtime identity.
  const envelope = <TResult>(result: TResult): RuntimeRpcSuccess<TResult> =>
    lastEnvelope
      ? { ...lastEnvelope, result }
      : { id: 'local', ok: true, result, _meta: { runtimeId: 'client' } }
  return { search, envelope }
}

export const SEARCH_HANDLERS: Record<string, CommandHandler> = {
  search: async ({ client, flags, json }) => {
    const command = parseSearchCommand(flags)
    const { search, envelope } = createCliSessionSearch(client)
    if (command.kind === 'index-status') {
      printResult(envelope(await search.searchStatus()), json, formatSessionSearchStatus)
      return
    }
    const response = await search.searchSessions(command.request)
    if (response.kind === 'malformed-cursor') {
      throw new RuntimeClientError('invalid_argument', MALFORMED_CURSOR_MESSAGE)
    }
    printResult(envelope(response), json, formatSessionSearchResponse)
  }
}
