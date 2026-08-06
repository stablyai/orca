import { ipcMain } from 'electron'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult,
  AiVaultSessionResumePreparation
} from '../../shared/ai-vault-resume-preparation'
import { parseExecutionHostId } from '../../shared/execution-host'

export type AiVaultResumeHandlerOptions = {
  prepareSessionResume?: AiVaultSessionResumePreparation
  prepareRuntimeSessionResume?: (
    environmentId: string,
    args: AiVaultPrepareSessionResumeArgs
  ) => Promise<AiVaultPrepareSessionResumeResult>
}

export function registerAiVaultResumeHandler(options: AiVaultResumeHandlerOptions): void {
  ipcMain.handle('aiVault:prepareSessionResume', (_event, args: AiVaultPrepareSessionResumeArgs) =>
    prepareAiVaultSessionResume(args, options)
  )
}

export async function prepareAiVaultSessionResume(
  args: AiVaultPrepareSessionResumeArgs,
  options: AiVaultResumeHandlerOptions
): Promise<AiVaultPrepareSessionResumeResult> {
  const executionHost = parseExecutionHostId(args.executionHostId)
  if (executionHost?.kind === 'runtime') {
    if (!options.prepareRuntimeSessionResume) {
      throw new Error('The session host is unavailable. Reconnect it and retry resume.')
    }
    return options.prepareRuntimeSessionResume(executionHost.environmentId, args)
  }
  // Why: the desktop process must never materialize transcript paths owned by an SSH host.
  if (executionHost?.kind === 'ssh') {
    return { useRealCodexHome: false }
  }
  return options.prepareSessionResume?.(args) ?? { useRealCodexHome: false }
}
