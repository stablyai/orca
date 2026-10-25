import {
  ConversationReferenceReadParams,
  ConversationReferencePageSchema,
  type ConversationReferencePage
} from '../../shared/conversation-reference'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'

function readHandler(search: boolean): CommandHandler {
  return async ({ client, flags, json }) => {
    const query = flags.get('query')
    if (search && typeof query !== 'string') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Provide --query to search the referenced conversation.'
      )
    }
    const parsed = ConversationReferenceReadParams.safeParse({
      reference: flags.get('reference'),
      cursor: flags.get('cursor'),
      ...(search ? { query } : {}),
      ...(flags.has('from') ? { fromMessage: Number(flags.get('from')) } : {}),
      ...(flags.has('limit') ? { limit: Number(flags.get('limit')) } : {})
    })
    if (!parsed.success) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Provide a conversation reference URI, a valid cursor, and a limit from 1 to 100.'
      )
    }
    const response = await client.call<ConversationReferencePage>('conversation.read', parsed.data)
    response.result = ConversationReferencePageSchema.parse(response.result)
    printResult(response, json, (page) =>
      [
        `${page.reference.title} (${page.reference.agent})`,
        ...page.messages.map(
          (message) =>
            `[${message.messageIndex + 1} ${message.role}${message.textOffset ? ` +${message.textOffset}` : ''}]\n${message.text}`
        ),
        ...page.warnings.map((warning) => `Warning: ${warning}`),
        page.nextCursor ? `Continue with --cursor '${page.nextCursor}'` : 'End of results.'
      ].join('\n\n')
    )
  }
}

export const CONVERSATION_HANDLERS: Record<string, CommandHandler> = {
  'conversation read': readHandler(false),
  'conversation search': readHandler(true)
}
