import { AiVaultPrepareSessionResumeParams } from '../../shared/rpc-contract/ai-vault-params'
import { prepareStructuredChatCliFork } from '../ai-vault/structured-chat-cli-fork'
import { ipcMain } from 'electron'
import type {
  AiVaultPrepareSessionResumeRequest,
  AiVaultPrepareSessionResumeResult,
  AiVaultSessionResumePreparation
} from '../../shared/ai-vault-resume-preparation'
import { isUnresolvedOwnerHostId, parseExecutionHostId } from '../../shared/execution-host'
import { isWslUncPath } from '../../shared/wsl-paths'
import { assertLegacyAiVaultResumeAllowed } from '../ai-vault/structured-session-ownership'
import { tryEnsureStructuredAgentSessionHostForResume } from '../runtime/structured-agent-session-host-refusal'
import { copyStructuredChatConversation } from '../ai-vault/structured-chat-conversation-copy'

export type AiVaultResumeHandlerOptions = {
  ensureStructuredSessionOwnership?: () => Promise<void>
  prepareSessionResume?: AiVaultSessionResumePreparation
  prepareRuntimeSessionResume?: (
    environmentId: string,
    args: AiVaultPrepareSessionResumeRequest
  ) => Promise<AiVaultPrepareSessionResumeResult>
}

export function registerAiVaultResumeHandler(options: AiVaultResumeHandlerOptions): void {
  ipcMain.handle(
    'aiVault:prepareSessionResume',
    (_event, args: AiVaultPrepareSessionResumeRequest) => prepareAiVaultSessionResume(args, options)
  )
}

export async function prepareAiVaultSessionResume(
  args: AiVaultPrepareSessionResumeRequest,
  options: AiVaultResumeHandlerOptions
): Promise<AiVaultPrepareSessionResumeResult> {
  const executionHost = parseExecutionHostId(args.executionHostId)
  if (executionHost?.kind === 'runtime') {
    if (!options.prepareRuntimeSessionResume || isUnresolvedOwnerHostId(executionHost.id)) {
      throw new Error('The session host is unavailable. Reconnect it and retry resume.')
    }
    return options.prepareRuntimeSessionResume(executionHost.environmentId, args)
  }
  if ('sourceChat' in args) {
    const parsed = AiVaultPrepareSessionResumeParams.parse(args)
    if (!('sourceChat' in parsed)) {
      throw new Error('Invalid chat source.')
    }
    if (executionHost?.kind === 'ssh') {
      throw new Error('This chat cannot be copied on this host.')
    }
    await options.ensureStructuredSessionOwnership?.()
    return prepareStructuredChatCliFork(
      parsed,
      options.prepareSessionResume ?? (async () => ({ useRealCodexHome: false }))
    )
  }
  // Why: the desktop process must never materialize transcript paths owned by an SSH host.
  if (executionHost?.kind === 'ssh') {
    return { useRealCodexHome: false }
  }
  if (!isWslUncPath(args.filePath)) {
    if (options.ensureStructuredSessionOwnership) {
      await (args.codexHome === null && !args.fork
        ? tryEnsureStructuredAgentSessionHostForResume(options.ensureStructuredSessionOwnership)
        : options.ensureStructuredSessionOwnership())
    }
    assertLegacyAiVaultResumeAllowed(args)
  }
  return (
    (await copyStructuredChatConversation(args)) ??
    options.prepareSessionResume?.(args) ?? { useRealCodexHome: false }
  )
}
