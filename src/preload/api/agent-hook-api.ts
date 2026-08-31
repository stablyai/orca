import type { OrcaHooks } from '../../shared/orca-yaml-hook-types'
import type { WorktreeSetupLaunch } from '../../shared/worktree/launch-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { SetupScriptImportCandidate } from '../../shared/setup-script-imports'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'

export type HooksApi = {
  check: (args: { repoId: string; hostId?: ExecutionHostId }) => Promise<{
    status?: 'ok' | 'error'
    hasHooks: boolean
    hooks: OrcaHooks | null
    mayNeedUpdate: boolean
  }>
  inspectSetupScriptImports: (args: {
    repoId: string
    hostId?: ExecutionHostId
  }) => Promise<SetupScriptImportCandidate[]>
  createIssueCommandRunner: (args: {
    repoId: string
    worktreePath: string
    command: string
  }) => Promise<WorktreeSetupLaunch>
  readIssueCommand: (args: { repoId: string; hostId?: ExecutionHostId }) => Promise<{
    status?: 'ok' | 'error'
    localContent: string | null
    sharedContent: string | null
    effectiveContent: string | null
    localFilePath: string
    source: 'local' | 'shared' | 'none'
  }>
  writeIssueCommand: (args: {
    repoId: string
    content: string
    hostId?: ExecutionHostId
  }) => Promise<void>
}

export type AgentHooksApi = {
  claudeStatus: () => Promise<AgentHookInstallStatus>
  openClaudeStatus: () => Promise<AgentHookInstallStatus>
  codexStatus: () => Promise<AgentHookInstallStatus>
  geminiStatus: () => Promise<AgentHookInstallStatus>
  antigravityStatus: () => Promise<AgentHookInstallStatus>
  ampStatus: () => Promise<AgentHookInstallStatus>
  cursorStatus: () => Promise<AgentHookInstallStatus>
  droidStatus: () => Promise<AgentHookInstallStatus>
  commandCodeStatus: () => Promise<AgentHookInstallStatus>
  grokStatus: () => Promise<AgentHookInstallStatus>
  copilotStatus: () => Promise<AgentHookInstallStatus>
  hermesStatus: () => Promise<AgentHookInstallStatus>
  devinStatus: () => Promise<AgentHookInstallStatus>
}
