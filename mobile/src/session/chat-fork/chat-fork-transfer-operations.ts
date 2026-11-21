import {
  AiVaultAppendChatForkImportParams,
  AiVaultAppendChatForkImportResultSchema,
  AiVaultBeginChatForkImportParams,
  AiVaultBeginChatForkImportResultSchema,
  AiVaultCancelChatForkImportResultSchema,
  AiVaultChatForkImportIdParams,
  AiVaultCommitChatForkImportResultSchema,
  AiVaultExportChatForkParams,
  AiVaultExportChatForkResultSchema,
  AiVaultReadChatForkExportParams,
  AiVaultReadChatForkExportResultSchema,
  AiVaultReleaseChatForkExportParams,
  AiVaultReleaseChatForkExportResultSchema
} from '../../../../src/shared/rpc-contract/ai-vault/ai-vault-fork-transfer-params'
import type { ChatForkRelayCall } from '../../../../src/shared/ai-vault/fork-transfer/chat-fork-transcript-relay'
import { defineRpcOperation, runRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

// Export and commit run the SDK copy on the host, which may take up to two minutes.
const CHAT_FORK_TRANSFER_RPC_TIMEOUT_MS = 150_000

// The host's refusal message is the transfer error code; the relay classifies it as is.
const exportChatFork = defineRpcOperation({
  name: 'aiVault.export-chat-fork',
  method: 'aiVault.exportChatFork',
  acceptance: 'require-result-or-throw-message',
  barrier: 'on-settle',
  read: rpcResultVariant('chat-fork-export', AiVaultExportChatForkResultSchema)
})

const readChatForkExport = defineRpcOperation({
  name: 'aiVault.read-chat-fork-export',
  method: 'aiVault.readChatForkExport',
  acceptance: 'require-result-or-throw-message',
  barrier: 'on-settle',
  read: rpcResultVariant('chat-fork-export-chunk', AiVaultReadChatForkExportResultSchema)
})

const releaseChatForkExport = defineRpcOperation({
  name: 'aiVault.release-chat-fork-export',
  method: 'aiVault.releaseChatForkExport',
  acceptance: 'require-result-or-throw-message',
  barrier: 'on-settle',
  read: rpcResultVariant('chat-fork-export-released', AiVaultReleaseChatForkExportResultSchema)
})

const beginChatForkImport = defineRpcOperation({
  name: 'aiVault.begin-chat-fork-import',
  method: 'aiVault.beginChatForkImport',
  acceptance: 'require-result-or-throw-message',
  barrier: 'on-settle',
  read: rpcResultVariant('chat-fork-import-begun', AiVaultBeginChatForkImportResultSchema)
})

const appendChatForkImport = defineRpcOperation({
  name: 'aiVault.append-chat-fork-import',
  method: 'aiVault.appendChatForkImport',
  acceptance: 'require-result-or-throw-message',
  barrier: 'on-settle',
  read: rpcResultVariant('chat-fork-import-appended', AiVaultAppendChatForkImportResultSchema)
})

const commitChatForkImport = defineRpcOperation({
  name: 'aiVault.commit-chat-fork-import',
  method: 'aiVault.commitChatForkImport',
  acceptance: 'require-result-or-throw-message',
  barrier: 'on-settle',
  read: rpcResultVariant('chat-fork-import-placed', AiVaultCommitChatForkImportResultSchema)
})

const cancelChatForkImport = defineRpcOperation({
  name: 'aiVault.cancel-chat-fork-import',
  method: 'aiVault.cancelChatForkImport',
  acceptance: 'require-result-or-throw-message',
  barrier: 'on-settle',
  read: rpcResultVariant('chat-fork-import-cancelled', AiVaultCancelChatForkImportResultSchema)
})

/** The relay's RPC to one host through its own client; params are checked before they leave. */
export function chatForkRelayCallFor(client: RpcClient, signal?: AbortSignal): ChatForkRelayCall {
  const options = { timeoutMs: CHAT_FORK_TRANSFER_RPC_TIMEOUT_MS, ...(signal ? { signal } : {}) }
  return async (method, params) => {
    switch (method) {
      case 'aiVault.exportChatFork':
        return runRpcOperation(
          client,
          exportChatFork,
          AiVaultExportChatForkParams.parse(params),
          options
        )
      case 'aiVault.readChatForkExport':
        return runRpcOperation(
          client,
          readChatForkExport,
          AiVaultReadChatForkExportParams.parse(params),
          options
        )
      case 'aiVault.releaseChatForkExport':
        return runRpcOperation(
          client,
          releaseChatForkExport,
          AiVaultReleaseChatForkExportParams.parse(params),
          options
        )
      case 'aiVault.beginChatForkImport':
        return runRpcOperation(
          client,
          beginChatForkImport,
          AiVaultBeginChatForkImportParams.parse(params),
          options
        )
      case 'aiVault.appendChatForkImport':
        return runRpcOperation(
          client,
          appendChatForkImport,
          AiVaultAppendChatForkImportParams.parse(params),
          options
        )
      case 'aiVault.commitChatForkImport':
        return runRpcOperation(
          client,
          commitChatForkImport,
          AiVaultChatForkImportIdParams.parse(params),
          options
        )
      case 'aiVault.cancelChatForkImport':
        return runRpcOperation(
          client,
          cancelChatForkImport,
          AiVaultChatForkImportIdParams.parse(params),
          options
        )
      default:
        throw new Error(`Unknown chat fork transfer method: ${method}`)
    }
  }
}
