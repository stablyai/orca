import {
  isRepoOnCatalogHost,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host/execution-host'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import { findOwnAgentCli } from '../../../agent-cli-update/agent-cli-own-install'
import { CodexAutomationUpdateError } from '../../../agent-cli-update/codex-automation-update'
import type { OrcaRuntimeService } from '../../orca-runtime'

/** Confirm that native Chat will select the same program before admitting its first message. */
export async function assertVerifiedCodexChatLaunch(
  runtime: Pick<OrcaRuntimeService, 'showTerminalWorkspaceLaunchScope' | 'requireStore'>,
  worktreeId: string,
  program: string,
  signal?: AbortSignal
): Promise<void> {
  const changed = new CodexAutomationUpdateError(
    'The verified Codex installation is unavailable for this chat launch.'
  )
  const scope = await runtime.showTerminalWorkspaceLaunchScope(`id:${worktreeId}`).catch(() => null)
  signal?.throwIfAborted()
  const hostId = scope?.folderWorkspace?.executionHostId
  if (
    !scope ||
    scope.connectionId ||
    (scope.repo && !isRepoOnCatalogHost(scope.repo)) ||
    (hostId && hostId !== LOCAL_EXECUTION_HOST_ID)
  ) {
    throw changed
  }
  const settings = runtime.requireStore().getSettings()
  const cli = await waitForPromiseWithSignal(
    findOwnAgentCli('codex', settings, scope.path).catch(() => null),
    signal
  )
  signal?.throwIfAborted()
  if (cli?.program !== program) {
    throw changed
  }
}
