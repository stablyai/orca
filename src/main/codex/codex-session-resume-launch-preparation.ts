import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import {
  trustedCodexResumeHomes,
  type CodexSessionResumePreparation
} from './codex-session-resume-home'
import { prepareCodexSessionResume } from './codex-session-resume-preparation'
import { codexHookService } from './hook-service'
import { reconcileCodexHooksForLaunch } from './codex-hook-reconcile'
import { ensureCodexDaemonSocketGuard } from './codex-config-mirror'
import { isAgentStatusHooksEnabledForAgent } from '../agent-hooks/managed-agent-hook-controls'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import type { GlobalSettings } from '../../shared/global-settings-types'

export function createCodexSessionResumeLaunchPreparation(deps: {
  getRuntimeHome: () => CodexRuntimeHomeService | null
  getSettings: () => GlobalSettings | undefined
}) {
  // Pinned homes bypass the selected-account preparation done by pane spawn.
  async function prepareCodexPinnedLaunchHome(
    home: string,
    systemHomePath: string = getSystemCodexHomePath()
  ): Promise<void> {
    const isSystemHome =
      normalizeRuntimePathForComparison(home) === normalizeRuntimePathForComparison(systemHomePath)
    const isHooksEnabled = (): boolean =>
      isAgentStatusHooksEnabledForAgent(deps.getSettings(), 'codex')
    try {
      if (isSystemHome) {
        await reconcileCodexHooksForLaunch()
      } else if (isHooksEnabled()) {
        await codexHookService.installForLaunchPrep(home, true, isHooksEnabled)
      } else {
        await codexHookService.refreshRuntimeUserHooksForLaunchPrep(home)
      }
    } catch (error) {
      // Hook repair must not prevent launch in the verified home.
      console.warn('[codex-hook-service] failed to prepare automatic resume home:', error)
    }
    if (!isSystemHome) {
      // Hook repair may skip or fail before its config mirror applies the guard.
      ensureCodexDaemonSocketGuard(home)
    }
  }

  async function prepareCodexSessionResumeForLaunch(args: {
    providerSession: AgentProviderSessionMetadata
    target: CodexAccountSelectionTarget
    launchEnv?: NodeJS.ProcessEnv
    useSelectedAccount?: boolean
  }): Promise<CodexSessionResumePreparation | null> {
    const runtimeHome = deps.getRuntimeHome()
    if (args.target.runtime === 'wsl' || !runtimeHome || !deps.getSettings()) {
      return null
    }
    const systemHomePath = getSystemCodexHomePath()
    const trustedHomes = trustedCodexResumeHomes(runtimeHome, systemHomePath)
    // Refuse unreadable selections before provenance matching can choose another account.
    const selectedAccountCodexHome = runtimeHome.resolveSelectedHostAccountCodexHomePathForResume()
    const preparation = await prepareCodexSessionResume({
      sessionId: args.providerSession.id,
      transcriptPath: args.providerSession.transcriptPath,
      trustedCodexHomes: trustedHomes,
      getSelectedAccountCodexHome: () => selectedAccountCodexHome,
      systemCodexHomePath: systemHomePath,
      sharedRuntimeCodexHomePath: getOrcaManagedCodexHomePath(),
      resolveVerifiedResumeHome: async (sessionSource) => {
        const resumeHome =
          (await runtimeHome.prepareForCodexLaunchAsync(undefined, args.launchEnv, {
            conversationHome: sessionSource.homePath,
            transcriptPath: sessionSource.transcriptPath
          })) ?? systemHomePath
        await prepareCodexPinnedLaunchHome(resumeHome, systemHomePath)
        return resumeHome
      }
    })
    return preparation.outcome === 'resume'
      ? {
          ...preparation,
          reconcileSharedRuntimeAuth:
            normalizeRuntimePathForComparison(preparation.codexHomePath) ===
            normalizeRuntimePathForComparison(getOrcaManagedCodexHomePath())
        }
      : preparation
  }

  return { prepareCodexSessionResumeForLaunch, prepareCodexPinnedLaunchHome }
}
