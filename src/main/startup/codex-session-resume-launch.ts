import { app } from 'electron'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import type { CodexSessionResumePreparation } from '../codex/codex-session-resume-home'
import { prepareCodexSessionResume } from '../codex/codex-session-resume-preparation'
import {
  prepareCodexAccountRestartResume,
  prepareLegacySharedCodexSessionResume
} from '../codex/codex-legacy-session-resume'
import { ManagedCodexHomeTemporarilyUnavailableError } from '../codex-accounts/host-codex-managed-home-ownership'
import { codexHookService } from '../codex/hook-service'
import {
  awaitRealHomeCodexHookTrust,
  ensureRealHomeCodexHookState
} from '../codex/codex-real-home-hook-install'
import { ensureCodexDaemonSocketGuard } from '../codex/codex-config-mirror'
import { isAgentStatusHooksEnabledForAgent } from '../agent-hooks/managed-agent-hook-controls'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../codex/codex-home-paths'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { mainProcessState as state } from './main-process-state'

export async function prepareCodexSessionResumeForLaunch(args: {
  providerSession: AgentProviderSessionMetadata
  target: CodexAccountSelectionTarget
  launchEnv?: NodeJS.ProcessEnv
  useSelectedAccount?: boolean
}): Promise<CodexSessionResumePreparation | null> {
  const runtimeHome = state.codexRuntimeHome
  const store = state.store
  if (args.target.runtime === 'wsl' || !runtimeHome || !store) {
    return null
  }
  const systemHomePath = getSystemCodexHomePath()
  // Why: codexSessionSourceHome is import-only; treating it as CODEX_HOME would mutate history sources and bypass account auth.
  const trustedHomes = [systemHomePath, ...runtimeHome.getHostCodexHomePathsForSessionDiscovery()]
  // Why: resolved eagerly, once, before any ranking or provenance match. The
  // marker read used to be deferred into the ranking thunk so a
  // provenance-present resume never paid for it, but that optimisation let an
  // unreadable selected home reach the PTY as "no selection": the provenance
  // branch simply omits the account from `trustedHomes` and another account's
  // readable alias wins. A throw here refuses the whole resume instead
  // (#STA-4422).
  const selectedAccountCodexHome = runtimeHome.resolveSelectedHostAccountCodexHomePathForResume()
  // Why: a `fresh` outcome must skip migration and hook repair entirely — there is
  // no verified origin home to prepare, so the PTY layer drops the resume argv (#10793).
  const preparation = await prepareCodexSessionResume({
    sessionId: args.providerSession.id,
    transcriptPath: args.providerSession.transcriptPath,
    trustedCodexHomes: trustedHomes,
    // Why: the legacy id rescan's winning home becomes this pane's CODEX_HOME, i.e. its account;
    // rank it by the current selection so settings insertion order can never decide the account.
    getSelectedAccountCodexHome: () => selectedAccountCodexHome,
    systemCodexHomePath: systemHomePath,
    // Why: the mirror winning is what triggers the migration into ~/.codex below, so it must
    // outrank the path-sorted account homes or a system-default selection resumes as an account.
    sharedRuntimeCodexHomePath: getOrcaManagedCodexHomePath(),
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
            isHostSystemDefaultRealHome: () => runtimeHome.isHostSystemDefaultRealHome(),
            systemCodexHomePath: systemHomePath
          }
        )
      } catch (error) {
        // A credential-read refusal must never fall back to the old account.
        if (error instanceof ManagedCodexHomeTemporarilyUnavailableError) {
          throw error
        }
        // Why: migration is a compatibility repair; its failure must not prevent the PTY from resuming from its trusted origin home.
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
      const isSystemHome =
        normalizeRuntimePathForComparison(resumeHome) ===
        normalizeRuntimePathForComparison(systemHomePath)
      const hooksEnabled = isAgentStatusHooksEnabledForAgent(store.getSettings(), 'codex')
      try {
        if (isSystemHome) {
          await ensureRealHomeCodexHookState({
            hooksEnabled,
            userDataPath: app.getPath('userData'),
            writePolicy: 'add-missing-only'
          })
          // Why: beside an unapproved entry Codex opens a blocking hook-review screen,
          // and only the grant's own settle cannot race Codex's approval write.
          await awaitRealHomeCodexHookTrust()
        } else if (hooksEnabled) {
          await codexHookService.installForLaunchPrep(resumeHome)
        } else {
          await codexHookService.refreshRuntimeUserHooksForLaunchPrep(resumeHome)
        }
      } catch (error) {
        // Why: hook repair is best-effort; session provenance must still win over the currently selected home.
        console.warn('[codex-hook-service] failed to prepare automatic resume home:', error)
      }
      if (!isSystemHome) {
        // Why: this pins the resumed pane's CODEX_HOME, and hook repair above can skip or fail before its config mirror applies the daemon guard.
        ensureCodexDaemonSocketGuard(resumeHome)
      }
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
