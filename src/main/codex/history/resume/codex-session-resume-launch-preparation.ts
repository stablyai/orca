import { CODEX_ACCOUNT_RESTART_RESUME_ERROR } from '../../../../shared/agent-accounts/codex/codex-account-restart-stop'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { CodexAccountSelectionTarget } from '../../../../shared/agent-accounts/codex/codex-selection-lane'
import { isAmbiguousIdOnlyAccountResume } from './codex-session-resume-ambiguous-id'
import {
  trustedCodexResumeHomes,
  type CodexSessionResumePreparation
} from './codex-session-resume-home'
import { prepareCodexSessionResume } from './codex-session-resume-preparation'
import {
  prepareCodexAccountRestartResume,
  prepareLegacySharedCodexSessionResume,
  settleLegacySessionCopyBeforeResume
} from './codex-legacy-session-resume'
import { ManagedCodexHomeTemporarilyUnavailableError } from '../../../codex-accounts/managed-homes/host-codex-managed-home-ownership'
import { codexHookService } from '../../hooks/installation/hook-service'
import { reconcileCodexHooksForLaunch } from '../../hooks/reconciliation/codex-hook-reconcile'
import { ensureCodexDaemonSocketGuard } from '../../configuration/settings/codex-config-mirror'
import { isAgentStatusHooksEnabledForAgent } from '../../../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import {
  getOrcaManagedCodexHomePath,
  getSystemCodexHomePath,
  resolveOrcaManagedCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import type { CodexRuntimeHomeService } from '../../../codex-accounts/runtime-home-service'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'

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
      await deps.getRuntimeHome()?.prepareAccountHistoryForPinnedHome(home)
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
    const sharedRuntimeHomePath = getOrcaManagedCodexHomePath()
    const trustedHomes = trustedCodexResumeHomes(runtimeHome, systemHomePath)
    // Refuse unreadable selections before provenance matching can choose another account.
    const selectedAccountCodexHome = runtimeHome.resolveSelectedHostAccountCodexHomePathForResume()
    await settleLegacySessionCopyBeforeResume(
      args.providerSession.transcriptPath,
      resolveOrcaManagedCodexHomePath()
    )
    if (
      await isAmbiguousIdOnlyAccountResume({
        sessionId: args.providerSession.id,
        transcriptPath: args.providerSession.transcriptPath,
        trustedCodexHomes: trustedHomes,
        getSelectedAccountCodexHome: () => selectedAccountCodexHome,
        systemCodexHomePath: systemHomePath,
        sharedRuntimeCodexHomePath: sharedRuntimeHomePath
      })
    ) {
      // Without its transcript path the thread's account is ambiguous; never guess the credentials.
      throw new Error(CODEX_ACCOUNT_RESTART_RESUME_ERROR)
    }
    const preparation = await prepareCodexSessionResume({
      sessionId: args.providerSession.id,
      transcriptPath: args.providerSession.transcriptPath,
      trustedCodexHomes: trustedHomes,
      getSelectedAccountCodexHome: () => selectedAccountCodexHome,
      systemCodexHomePath: systemHomePath,
      sharedRuntimeCodexHomePath: sharedRuntimeHomePath,
      resolveVerifiedResumeHome: async (sessionSource) => {
        let migrated = { useRealCodexHome: false }
        try {
          migrated = await prepareLegacySharedCodexSessionResume(
            {
              agent: 'codex',
              executionHostId: 'local',
              filePath: sessionSource.transcriptPath,
              codexHome: sessionSource.homePath
            },
            {
              isHostSystemDefaultRealHomeSelected: () =>
                runtimeHome.isHostSystemDefaultRealHomeSelected(),
              systemCodexHomePath: systemHomePath,
              leaveSwapToAccountRestart: args.useSelectedAccount === true
            }
          )
        } catch (error) {
          // A credential-read refusal must never fall back to the old account.
          if (error instanceof ManagedCodexHomeTemporarilyUnavailableError) {
            throw error
          }
          // Failed migration can still resume from the verified origin home.
          console.warn(
            '[codex-session-resume] Legacy rollout migration failed; using origin home:',
            error
          )
        }
        const resumeHome = args.useSelectedAccount
          ? await prepareCodexAccountRestartResume({
              sourceHome: sessionSource.homePath,
              transcriptPath: sessionSource.transcriptPath,
              targetHome: selectedAccountCodexHome ?? systemHomePath,
              systemCodexHomePath: systemHomePath
            })
          : migrated.useRealCodexHome
            ? systemHomePath
            : sessionSource.homePath
        await prepareCodexPinnedLaunchHome(resumeHome, systemHomePath)
        return resumeHome
      }
    })
    return preparation.outcome === 'resume'
      ? {
          ...preparation,
          reconcileSharedRuntimeAuth:
            normalizeRuntimePathForComparison(preparation.codexHomePath) ===
            normalizeRuntimePathForComparison(sharedRuntimeHomePath)
        }
      : preparation
  }

  return { prepareCodexSessionResumeForLaunch, prepareCodexPinnedLaunchHome }
}
