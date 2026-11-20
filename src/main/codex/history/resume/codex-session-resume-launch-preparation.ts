import { join } from 'node:path'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { CodexAccountSelectionTarget } from '../../../../shared/agent-accounts/codex/codex-selection-lane'
import {
  codexDatedRolloutRelativePath,
  trustedCodexResumeHomes,
  type CodexSessionResumePreparation
} from './codex-session-resume-home'
import { getNewerLegacyCopiedCodexSessionSource } from '../bridges/codex-session-bridge'
import { prepareCodexSessionResume } from './codex-session-resume-preparation'
import {
  prepareCodexAccountRestartResume,
  prepareLegacySharedCodexSessionResume
} from './codex-legacy-session-resume'
import { ManagedCodexHomeTemporarilyUnavailableError } from '../../../codex-accounts/managed-homes/host-codex-managed-home-ownership'
import { codexHookService } from '../../hooks/installation/hook-service'
import { reconcileCodexHooksForLaunch } from '../../hooks/reconciliation/codex-hook-reconcile'
import { ensureCodexDaemonSocketGuard } from '../../configuration/settings/codex-config-mirror'
import { isAgentStatusHooksEnabledForAgent } from '../../../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import {
  getOrcaManagedCodexHomePath,
  getSystemCodexHomePath
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
    const trustedHomes = trustedCodexResumeHomes(runtimeHome, systemHomePath)
    // Refuse unreadable selections before provenance matching can choose another account.
    const selectedAccountCodexHome = runtimeHome.resolveSelectedHostAccountCodexHomePathForResume()
    const savedTranscriptPath = args.providerSession.transcriptPath
    const sharedRuntimeCodexHomePath = getOrcaManagedCodexHomePath()
    // Old copies are never linked any more: an untouched one whose source grew resumes the source.
    // An account restart moves the resumed rollout, so it keeps the copy.
    const newerSource =
      savedTranscriptPath && !args.useSelectedAccount
        ? await getNewerLegacyCopiedCodexSessionSource(
            savedTranscriptPath,
            sharedRuntimeCodexHomePath
          )
        : null
    const redirected =
      newerSource !== null &&
      codexDatedRolloutRelativePath(join(systemHomePath, 'sessions'), newerSource) !== null
    const transcriptPath = redirected ? newerSource : savedTranscriptPath
    // Off the real-home route the copy resumed under the shared runtime home's account check; the
    // source keeps it.
    const keepSharedRuntimeCheck = redirected && !runtimeHome.isHostSystemDefaultRealHomeSelected()
    const preparation = await prepareCodexSessionResume({
      sessionId: args.providerSession.id,
      transcriptPath,
      trustedCodexHomes: trustedHomes,
      getSelectedAccountCodexHome: () => selectedAccountCodexHome,
      systemCodexHomePath: systemHomePath,
      sharedRuntimeCodexHomePath,
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
              systemCodexHomePath: systemHomePath
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
    if (preparation.outcome !== 'resume') {
      return preparation
    }
    return keepSharedRuntimeCheck
      ? {
          ...preparation,
          reconcileSharedRuntimeAuth: true,
          reconcileAgainstHomePath: sharedRuntimeCodexHomePath
        }
      : {
          ...preparation,
          reconcileSharedRuntimeAuth:
            normalizeRuntimePathForComparison(preparation.codexHomePath) ===
            normalizeRuntimePathForComparison(sharedRuntimeCodexHomePath)
        }
  }

  return { prepareCodexSessionResumeForLaunch, prepareCodexPinnedLaunchHome }
}
