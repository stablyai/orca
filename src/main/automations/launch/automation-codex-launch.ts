import {
  isRepoOnCatalogHost,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host/execution-host'
import { isTuiAgentEnabled } from '../../../shared/agent-launch/catalog/tui-agent-selection'
import { parseWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import type { Automation } from '../../../shared/automations/automation-definition'
import {
  CodexAutomationUpdateError,
  prepareCodexInstallation
} from '../../agent-cli-update/codex-automation-update'
import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { AutomationRepoRunTarget } from '../ownership/run-target-resolution'

export const CODEX_UPDATE_HOST_UNSUPPORTED =
  'Checking for Codex updates is unavailable on this execution host.'

export async function prepareAutomationCodexLaunch(
  runtime: Pick<OrcaRuntimeService, 'resolveManagedTerminalWorkspaceTarget'>,
  store: Pick<Store, 'getSettings'>,
  automation: Pick<
    Automation,
    'executionTargetType' | 'runContext' | 'workspaceMode' | 'workspaceId'
  >,
  target: AutomationRepoRunTarget,
  signal: AbortSignal
): Promise<string> {
  const unsupported = new CodexAutomationUpdateError(CODEX_UPDATE_HOST_UNSUPPORTED)
  if (
    (process.platform !== 'darwin' && process.platform !== 'linux') ||
    !isRepoOnCatalogHost(target.repo) ||
    automation.executionTargetType === 'ssh' ||
    (automation.runContext && automation.runContext.hostId !== LOCAL_EXECUTION_HOST_ID)
  ) {
    throw unsupported
  }
  if (automation.workspaceMode === 'existing') {
    const scope = parseWorkspaceKey(automation.workspaceId ?? '')
    const workspace = await runtime
      .resolveManagedTerminalWorkspaceTarget(
        `id:${automation.workspaceId}`,
        scope?.type === 'folder' ? undefined : LOCAL_EXECUTION_HOST_ID,
        false
      )
      .catch(() => null)
    const host =
      workspace?.scope.folderWorkspace?.executionHostId ?? workspace?.managedWorktree?.hostId
    if (
      !workspace?.managedWorktree ||
      workspace.scope.connectionId ||
      (workspace.scope.repo && !isRepoOnCatalogHost(workspace.scope.repo)) ||
      (host && host !== LOCAL_EXECUTION_HOST_ID)
    ) {
      throw unsupported
    }
  }
  signal.throwIfAborted()
  const settings = store.getSettings()
  if (!isTuiAgentEnabled('codex', settings.disabledTuiAgents)) {
    throw new CodexAutomationUpdateError(
      'Codex is disabled in Settings. Enable it before running this automation.'
    )
  }
  return prepareCodexInstallation(settings, signal)
}
