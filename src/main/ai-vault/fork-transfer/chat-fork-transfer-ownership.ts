import type { AiVaultCommitChatForkImportResult } from '../../../shared/rpc-contract/ai-vault/ai-vault-fork-transfer-params'
import type { ChatForkTransferErrorCode } from '../../../shared/ai-vault/fork-transfer/chat-fork-transfer-limits'

export type StagedChatForkImportTarget = {
  worktreeId: string
  workspacePath: string
  sourceSessionId: string
  title?: string
}

export type StagedChatForkImport = StagedChatForkImportTarget & { filePath: string }

/** What a commit placed; replayed to a retried commit and read by the terminal launch. */
export type ChatForkImportLaunch = AiVaultCommitChatForkImportResult

export class ChatForkTransferError extends Error {
  constructor(readonly code: ChatForkTransferErrorCode) {
    super(code)
  }
}

/** Transfers belong to the paired device (or socket) that opened them. */
export function chatForkTransferOwner(context: {
  pairedDeviceId?: string
  clientId?: string
}): string {
  return context.pairedDeviceId ?? context.clientId ?? 'local'
}

/** The terminal-create option naming a placed import, bound to the caller asking. */
export function chatForkImportLaunchOption(
  sourceChatImport: { importId: string } | undefined,
  context: { pairedDeviceId?: string; clientId?: string }
): { sourceChatImport?: { importId: string; owner: string } } {
  return sourceChatImport
    ? {
        sourceChatImport: {
          importId: sourceChatImport.importId,
          owner: chatForkTransferOwner(context)
        }
      }
    : {}
}
