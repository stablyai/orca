import { isWslUncPath } from '../../../shared/file-access/wsl-paths'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import type { HistoryResumePlanner } from './history-resume-planner'

export class WorkspaceAccountSessionResume {
  constructor(private readonly planner: HistoryResumePlanner) {}

  accountForReceipt(token: string, provider: 'codex' | 'claude', workspaceId?: string) {
    return this.planner.accountForReceipt(token, provider, workspaceId)
  }

  async prepare(
    args: AiVaultPrepareSessionResumeArgs
  ): Promise<AiVaultPrepareSessionResumeResult | null> {
    if (
      !args.commitToken &&
      !args.historyCatalog &&
      (!args.workspaceId || args.fork || (args.agent !== 'codex' && args.agent !== 'claude'))
    ) {
      return null
    }
    if (args.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
      throw new Error('Continue this session on the host that owns it.')
    }
    if (args.commitToken || args.historyCatalog) {
      return this.planner.prepare(args)
    }
    if (!args.workspaceId || args.fork || (args.agent !== 'codex' && args.agent !== 'claude')) {
      return null
    }
    if (isWslUncPath(args.filePath)) {
      return null
    }
    return this.planner.prepare(args)
  }
}

let installed: WorkspaceAccountSessionResume | undefined
export function installWorkspaceAccountSessionResume(service: WorkspaceAccountSessionResume): void {
  installed = service
}
export function prepareWorkspaceAccountSessionResume(args: AiVaultPrepareSessionResumeArgs) {
  return installed?.prepare(args) ?? Promise.resolve(null)
}
export async function historyLaunchAccount(
  env: NodeJS.ProcessEnv | undefined,
  provider: 'codex' | 'claude',
  workspaceId?: string
) {
  const token = env?.ORCA_HISTORY_RESUME_RECEIPT
  if (!token) {
    return null
  }
  if (!installed) {
    throw new Error('History account preparation is unavailable on this host.')
  }
  return installed.accountForReceipt(token, provider, workspaceId)
}
