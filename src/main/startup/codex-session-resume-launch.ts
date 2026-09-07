import { app } from 'electron'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import type { CodexSessionResumePreparation } from '../codex/codex-session-resume-home'
import { prepareCodexSessionResume } from '../codex/codex-session-resume-preparation'
import { prepareLegacySharedCodexSessionResume } from '../codex/codex-legacy-session-resume'
import { ManagedCodexHomeTemporarilyUnavailableError } from '../codex-accounts/host-codex-managed-home-ownership'
import { codexHookService } from '../codex/hook-service'
import { ensureRealHomeCodexHookState } from '../codex/codex-real-home-hook-install'
import { isAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import { markCodexProjectTrusted } from '../agent-trust-presets'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../codex/codex-home-paths'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { resolveCodexAccountSwitchResumeHome } from '../codex/codex-account-switch-resume-repin'
import { transferCodexThreadGoalBetweenHomes } from '../codex/codex-thread-goal-transfer'
import { mainProcessState as state } from './main-process-state'

/**
 * Repins an account-switch restart onto the selected account, carrying the goal.
 *
 * Returns null when the switch has to give the conversation up: the user asked
 * for an account, and honouring that beats keeping them on the one they left.
 * The caller turns that into a `fresh` outcome, which drops the resume argv and
 * tells the pane its conversation did not come along.
 */
async function moveCodexResumeToSelectedAccount(args: {
  originHome: string
  transcriptPath: string
  threadId: string
}): Promise<string | null> {
  const selectedHome =
    state.codexRuntimeHome?.resolveSelectedHostAccountCodexHomePathForResume() ?? null
  const move = resolveCodexAccountSwitchResumeHome({
    originCodexHomePath: args.originHome,
    selectedCodexHomePath: selectedHome,
    transcriptPath: args.transcriptPath
  })
  if (move.outcome === 'already-there') {
    return args.originHome
  }
  if (move.outcome === 'unmovable') {
    return null
  }
  await transferCodexThreadGoalBetweenHomes({
    threadId: args.threadId,
    originCodexHomePath: args.originHome,
    targetCodexHomePath: move.codexHomePath
  })
  return move.codexHomePath
}

export async function prepareCodexSessionResumeForLaunch(args: {
  providerSession: AgentProviderSessionMetadata
  target: CodexAccountSelectionTarget
  launchEnv?: NodeJS.ProcessEnv
  workspacePath?: string
  accountSwitchRestart?: boolean
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
  let accountSwitchGaveUpResume = false
  // Why: a `fresh` outcome must skip migration, trust and hook repair entirely — there is
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
        // Why: this launch path pins CODEX_HOME to the account that OWNS the
        // rollout and deliberately refuses to repin onto whichever account is
        // selected now (#10793), so it does not wire
        // getSelectedHostAccountCodexHomePath and this branch cannot fire today.
        // It stays as a contract guard: the blanket catch below must never
        // silently swallow a typed refusal if that ever changes.
        if (error instanceof ManagedCodexHomeTemporarilyUnavailableError) {
          throw error
        }
        // Why: migration is a compatibility repair; its failure must not prevent the PTY from resuming from its trusted origin home.
        console.warn(
          '[codex-session-resume] Legacy rollout migration failed; using origin home:',
          error
        )
      }
      const originHome = migrated.useRealCodexHome ? systemHomePath : sessionSource.homePath
      const movedHome = args.accountSwitchRestart
        ? await moveCodexResumeToSelectedAccount({
            originHome,
            transcriptPath: sessionSource.transcriptPath,
            threadId: args.providerSession.id
          })
        : originHome
      if (movedHome === null) {
        accountSwitchGaveUpResume = true
        return originHome
      }
      const resumeHome = movedHome
      if (args.workspacePath) {
        try {
          await markCodexProjectTrusted(args.workspacePath)
        } catch (error) {
          console.warn('[codex-project-trust] failed to pre-mark resumed workspace:', error)
        }
      }
      const isSystemHome =
        normalizeRuntimePathForComparison(resumeHome) ===
        normalizeRuntimePathForComparison(systemHomePath)
      const hooksEnabled = isAgentStatusHooksEnabled(store.getSettings())
      try {
        if (isSystemHome) {
          await ensureRealHomeCodexHookState({
            hooksEnabled,
            userDataPath: app.getPath('userData')
          })
        } else if (hooksEnabled) {
          await codexHookService.installForLaunchPrep(resumeHome)
        } else {
          await codexHookService.refreshRuntimeUserHooksForLaunchPrep(resumeHome)
        }
      } catch (error) {
        // Why: hook repair is best-effort; session provenance must still win over the currently selected home.
        console.warn('[codex-hook-service] failed to prepare automatic resume home:', error)
      }
      return resumeHome
    }
  })
  if (accountSwitchGaveUpResume) {
    // Why claimedCodexProvenance: the rollout is real and was verified — the
    // account move is what it could not survive — so the pane owes the user the
    // "your conversation did not come along" notice rather than silence.
    return { outcome: 'fresh', claimedCodexProvenance: true }
  }
  return preparation.outcome === 'resume'
    ? {
        ...preparation,
        reconcileSharedRuntimeAuth:
          normalizeRuntimePathForComparison(preparation.codexHomePath) ===
          normalizeRuntimePathForComparison(getOrcaManagedCodexHomePath())
      }
    : preparation
}
