import { defineMethod } from '../../core'
import {
  AiVaultAppendChatForkImportParams,
  AiVaultBeginChatForkImportParams,
  AiVaultChatForkImportIdParams,
  AiVaultExportChatForkParams,
  AiVaultReadChatForkExportParams,
  AiVaultReleaseChatForkExportParams
} from '../../../../../shared/rpc-contract/ai-vault/ai-vault-fork-transfer-params'
import { isWslUncPath } from '../../../../../shared/wsl-paths'
import { claudeDestinationBucket } from '../../../../claude/transcripts/claude-conversation-copy'
import { exportChatFork } from '../../../../ai-vault/fork-transfer/chat-fork-export'
import { placeChatForkImport } from '../../../../ai-vault/fork-transfer/chat-fork-import-placement'
import { chatForkTransferStore } from '../../../../ai-vault/fork-transfer/chat-fork-transfer-store'
import {
  ChatForkTransferError,
  chatForkTransferOwner
} from '../../../../ai-vault/fork-transfer/chat-fork-transfer-ownership'

/** A chat forked to another host: the source cuts and serves it, the client relays it in chunks,
 *  and the target places it in one of its own workspaces. */
export const AI_VAULT_FORK_TRANSFER_METHODS = [
  defineMethod({
    name: 'aiVault.exportChatFork',
    permission: 'workspace',
    params: AiVaultExportChatForkParams,
    handler: (params, context) =>
      exportChatFork({
        request: params,
        owner: chatForkTransferOwner(context),
        store: chatForkTransferStore(),
        ensureStructuredHost: () => context.runtime.ensureStructuredAgentSessionHost()
      })
  }),
  defineMethod({
    name: 'aiVault.readChatForkExport',
    permission: 'workspace',
    params: AiVaultReadChatForkExportParams,
    handler: (params, context) =>
      chatForkTransferStore().readExport(
        chatForkTransferOwner(context),
        params.exportId,
        params.offset,
        params.length
      )
  }),
  defineMethod({
    name: 'aiVault.releaseChatForkExport',
    permission: 'workspace',
    params: AiVaultReleaseChatForkExportParams,
    handler: (params, context) => ({
      released: chatForkTransferStore().releaseExport(
        chatForkTransferOwner(context),
        params.exportId
      )
    })
  }),
  defineMethod({
    name: 'aiVault.beginChatForkImport',
    permission: 'workspace',
    params: AiVaultBeginChatForkImportParams,
    handler: async (params, context) => {
      // The host resolves its own workspace path; the client never sends one.
      const workspace = await context.runtime.resolveTerminalWorkspaceLaunchScope(params.worktree)
      if (workspace.connectionId || isWslUncPath(workspace.path)) {
        throw new ChatForkTransferError('chat_fork_import_target_unsupported')
      }
      claudeDestinationBucket(workspace.path)
      return chatForkTransferStore().beginImport(chatForkTransferOwner(context), {
        worktreeId: workspace.id,
        workspacePath: workspace.path,
        sourceSessionId: params.sourceSessionId,
        byteLength: params.byteLength,
        sha256: params.sha256,
        ...(params.title ? { title: params.title } : {})
      })
    }
  }),
  defineMethod({
    name: 'aiVault.appendChatForkImport',
    permission: 'workspace',
    params: AiVaultAppendChatForkImportParams,
    handler: (params, context) =>
      chatForkTransferStore().appendImport(
        chatForkTransferOwner(context),
        params.importId,
        params.offset,
        Buffer.from(params.bytesBase64, 'base64')
      )
  }),
  defineMethod({
    name: 'aiVault.commitChatForkImport',
    permission: 'workspace',
    params: AiVaultChatForkImportIdParams,
    handler: async (params, context) => {
      const owner = chatForkTransferOwner(context)
      const store = chatForkTransferStore()
      const placed = await store.commitImport(owner, params.importId, (staged) =>
        placeChatForkImport(staged)
      )
      store.recordLaunch(owner, params.importId, {
        worktreeId: placed.worktreeId,
        sessionId: placed.sessionId,
        filePath: placed.filePath,
        cwd: placed.cwd
      })
      return placed
    }
  }),
  defineMethod({
    name: 'aiVault.cancelChatForkImport',
    permission: 'workspace',
    params: AiVaultChatForkImportIdParams,
    handler: (params, context) => ({
      cancelled: chatForkTransferStore().cancelImport(
        chatForkTransferOwner(context),
        params.importId
      )
    })
  })
]
