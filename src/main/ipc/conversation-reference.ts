import { ipcMain } from 'electron'
import { parseExecutionHostId } from '../../shared/execution-host'
import {
  ConversationReferenceCreateParams,
  ConversationReferenceReadParams
} from '../../shared/conversation-reference'
import {
  createLocalConversationReference,
  readLocalConversationReference
} from '../ai-vault/conversation-reference-reader'
import { listAiVaultSessions } from '../ai-vault/cached-session-list'
import { forwardConversationReference } from '../ai-vault/conversation-reference-routing'

export function registerConversationReferenceHandlers(ensureHost?: () => Promise<void>): void {
  ipcMain.handle('conversation:createReference', async (_event, input: unknown) => {
    const request = ConversationReferenceCreateParams.parse(input)
    const host = parseExecutionHostId(request.executionHostId)
    if (host?.kind === 'runtime') {
      return forwardConversationReference('conversation.createReference', request)
    }
    if (host?.kind === 'ssh') {
      throw new Error('Conversation references from this SSH host are not available.')
    }
    if (request.source.kind === 'structured') {
      await ensureHost?.()
    }
    return createLocalConversationReference(request, () => listAiVaultSessions({ unlimited: true }))
  })
  ipcMain.handle('conversation:read', async (_event, input: unknown) => {
    const request = ConversationReferenceReadParams.parse(input)
    return (
      (await readLocalConversationReference(request, undefined, ensureHost)) ??
      forwardConversationReference('conversation.read', request)
    )
  })
}
