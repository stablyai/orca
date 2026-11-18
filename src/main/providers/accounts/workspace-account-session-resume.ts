import { isWslUncPath } from '../../../shared/file-access/wsl-paths'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import type { HistoryResumePlanner } from './history-resume-planner'

export class WorkspaceAccountSessionResume {
  constructor(private readonly planner: HistoryResumePlanner) {}

  accountForSession(provider: 'codex' | 'claude', sessionId: string) {
    return this.planner.accountForSession(provider, sessionId)
  }

  async prepare(
    args: AiVaultPrepareSessionResumeArgs
  ): Promise<AiVaultPrepareSessionResumeResult | null> {
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
export function historyContinuationAccount(provider: 'codex' | 'claude', sessionId: string) {
  return installed?.accountForSession(provider, sessionId) ?? Promise.resolve(null)
}
export async function historyContinuationAccountHome(provider: string, sessionId: string) {
  if (provider !== 'codex' && provider !== 'claude') {
    return null
  }
  const account = await historyContinuationAccount(provider, sessionId)
  return account
    ? {
        variable: provider === 'codex' ? ('CODEX_HOME' as const) : ('CLAUDE_CONFIG_DIR' as const),
        path: account.home
      }
    : null
}
