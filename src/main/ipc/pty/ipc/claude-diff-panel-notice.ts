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

/** Resolve the host account home, preserving CLI defaults when no config override exists. */
function hostPaneClaudeConfigDirEnv(): string | undefined {
  const router = getClaudeProfileRouter()
  return router
    ? (router.routedHome() ?? router.userConfigDir())
    : process.env.CLAUDE_CONFIG_DIR?.trim() || undefined
}

export function installPtyClaudeDiffPanelNoticeIpcHandler(deps: Deps): void {
  getPtyIpc().handle(
    'pty:claudeDiffPanelMayAutoOpen',
    async (_event, args: { id: unknown; target?: unknown }): Promise<boolean> => {
      const id = args?.id
      // WSL/SSH Claude config belongs to the execution host.
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
        // Restored daemon IDs are not owned by the pre-swap provider.
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
