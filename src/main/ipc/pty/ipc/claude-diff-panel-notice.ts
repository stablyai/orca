import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { getPtyIpc } from '../../pty-host-bindings'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import { claudeDiffPanelMayAutoOpen } from '../../../claude/claude-diff-panel-auto-open'
import { probeRecentClaudeCliVersion } from '../../../claude/claude-hook-event-versions'
import { getClaudeProfileRouter } from '../../../claude-accounts/claude-profile-installed-router'
import { resolveClaudeCommand } from '../../../codex-cli/command'
import { ptyOwnership } from '../provider/ownership-state'
import { tryGetProviderForPty } from '../provider/registry'

type Deps = { getLocalPtyProviderStartupPromise: () => Promise<void> | undefined }

/** The CLAUDE_CONFIG_DIR a host pane's `claude` sees: the selected account's home, else the
 *  user's own; undefined when it runs on the CLI default. */
function hostPaneClaudeConfigDirEnv(): string | undefined {
  const router = getClaudeProfileRouter()
  return router
    ? (router.routedHome() ?? router.userConfigDir())
    : process.env.CLAUDE_CONFIG_DIR?.trim() || undefined
}

/** Whether Claude in a local host pane may open its diff panel unasked; false for any other pane. */
export function installPtyClaudeDiffPanelNoticeIpcHandler(deps: Deps): void {
  getPtyIpc().handle(
    'pty:claudeDiffPanelMayAutoOpen',
    async (_event, args: { id: unknown; target?: unknown }): Promise<boolean> => {
      const id = args?.id
      // Why host panes only: a WSL or SSH pane's Claude keeps its config on that other host.
      if (
        typeof id !== 'string' ||
        !isHostTarget(args?.target) ||
        isRemoteRuntimePtyId(id) ||
        parseAppSshPtyId(id) ||
        (ptyOwnership.get(id) ?? LOCAL_EXECUTION_HOST_ID) !== LOCAL_EXECUTION_HOST_ID
      ) {
        return false
      }
      try {
        // Why: the pre-swap provider does not own restored daemon ids.
        await deps.getLocalPtyProviderStartupPromise()
        const [version, size] = await Promise.all([
          probeRecentClaudeCliVersion(resolveClaudeCommand()),
          tryGetProviderForPty(id)?.getAppliedSize?.(id) ?? null
        ])
        return await claudeDiffPanelMayAutoOpen({
          configDirEnv: hostPaneClaudeConfigDirEnv(),
          version,
          cols: size?.cols ?? null
        })
      } catch {
        return false
      }
    }
  )
}

function isHostTarget(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && 'runtime' in value && value.runtime === 'host'
  )
}
