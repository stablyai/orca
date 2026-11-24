import type { TuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent'
import { createChatWorkspaceDraft } from '../../../src/shared/repository/chat-workspace-draft'
import { createNonSecureContextUuid } from '../../../src/shared/identifiers/non-secure-context-uuid'
import { translate } from '../i18n/mobile-i18n'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { readWorktreeCatalogSnapshot } from '../worktree/catalog/worktree-catalog-snapshot-client'
import {
  agentLaunchExistingParams,
  readAgentLaunchNotice
} from '../session/agent-launch/agent-launch-request'
import { agentLaunchReplayRun } from './creation/mobile-workspace-create-operations'
import { chatWorkspaceCreate, chatWorkspaceNoteWrite } from './chat-workspace-operations'
import { isMobileMethodUnavailableError } from '../transport/rpc/mobile-method-unavailable'

export function newChatWorkspaceSubmission() {
  const draft = createChatWorkspaceDraft()
  const operationId = createNonSecureContextUuid()
  let createdRepo: { id: string; path: string; displayName: string } | null = null
  let noteSaved = false
  let intent: { agent: TuiAgent | '__blank__'; note: string } | null = null
  return {
    async create(client: RpcClient, choice: { agent: TuiAgent | '__blank__'; note: string }) {
      intent ??= { ...choice, note: choice.note.trim() }
      if (!createdRepo) {
        const response = await chatWorkspaceCreate.request(client, {
          name: draft.name,
          displayName: translate('chats.newProjectDate', 'New project-{{date}}', {
            date: draft.date
          })
        })
        if (
          !response.ok &&
          isMobileMethodUnavailableError(response.error.code, response.error.message)
        ) {
          throw new Error(
            translate(
              'chats.updateHost',
              'Update Orca on the selected host to create a chat workspace.'
            )
          )
        }
        const reply = chatWorkspaceCreate.interpret(response)
        if ('error' in reply) {
          throw new Error(reply.error)
        }
        createdRepo = reply.repo
      }
      const catalog = await readWorktreeCatalogSnapshot(client, undefined)
      const root = catalog.worktrees.find(
        (row) => row.repoId === createdRepo?.id && row.path === createdRepo.path
      )
      if (!root) {
        throw new Error(
          translate('chats.createdNotOpened', 'Chat was created. Open it from Chats.')
        )
      }
      const warnings: string[] = []
      if (intent.note && !noteSaved) {
        try {
          chatWorkspaceNoteWrite.interpret(
            await chatWorkspaceNoteWrite.request(client, {
              worktree: `id:${root.worktreeId}`,
              comment: intent.note
            })
          )
          noteSaved = true
        } catch (failure) {
          warnings.push(
            failure instanceof Error
              ? failure.message
              : translate('chats.noteFailed', 'Could not save the note')
          )
        }
      }
      if (intent.agent !== '__blank__') {
        try {
          const launch = agentLaunchReplayRun.interpret(
            await agentLaunchReplayRun.request(
              client,
              agentLaunchExistingParams({
                agent: intent.agent,
                worktreeId: root.worktreeId,
                operationId,
                launchSource: 'mobile-chat-workspace'
              })
            )
          )
          const notice = readAgentLaunchNotice(launch)
          if (notice) {
            warnings.push(notice)
          }
        } catch (failure) {
          warnings.push(
            failure instanceof Error
              ? failure.message
              : translate(
                  'chats.agentFailed',
                  'Could not start the agent. Check the chat before starting another.'
                )
          )
        }
      }
      return {
        worktreeId: root.worktreeId,
        name: createdRepo.displayName,
        savedNote: noteSaved ? intent.note : null,
        warning: warnings.join(' ') || undefined
      }
    }
  }
}
