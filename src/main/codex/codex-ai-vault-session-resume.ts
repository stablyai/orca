import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import { getSystemCodexHomePath } from './codex-home-paths'
import { prepareLegacySharedCodexSessionResume } from './codex-legacy-session-resume'
import {
  resolveTrustedCodexSessionResumeHome,
  trustedCodexResumeHomes
} from './codex-session-resume-home'

type CodexAiVaultRuntimeHome = Pick<
  CodexRuntimeHomeService,
  | 'isHostSystemDefaultRealHomeSelected'
  | 'resolveSelectedHostAccountCodexHomePathForResume'
  | 'getHostCodexHomePathsForSessionDiscovery'
>

type CodexAiVaultResumeOptions = {
  runtimeHome: CodexAiVaultRuntimeHome | null
  systemCodexHomePath: string | undefined
  /** Readies a home a pane will pin as CODEX_HOME instead of the selected account's. */
  preparePinnedLaunchHome: (home: string) => Promise<void>
}

/** Keeps window and serve AI Vault resumes behind the same refusing account-home gate. */
export async function prepareCodexAiVaultSessionResume(
  args: AiVaultPrepareSessionResumeArgs,
  options: CodexAiVaultResumeOptions
): Promise<AiVaultPrepareSessionResumeResult> {
  const result = await prepareLegacySharedCodexSessionResume(args, {
    isHostSystemDefaultRealHomeSelected: () =>
      options.runtimeHome?.isHostSystemDefaultRealHomeSelected() === true,
    getSelectedHostAccountCodexHomePath: () =>
      options.runtimeHome?.resolveSelectedHostAccountCodexHomePathForResume() ?? null,
    systemCodexHomePath: options.systemCodexHomePath
  })
  // Why: a fork carries no provider session, so the pane spawn never readies the home a resume
  // would; when it keeps the row's own home, that home needs the same hooks here.
  if (args.fork && !result.useRealCodexHome && !result.substituteCodexHome) {
    try {
      await readyForkLaunchHome(args, options)
    } catch (error) {
      // Why: hook setup is best-effort; the fork still launches without it.
      console.warn('[codex-ai-vault-resume] could not ready the fork launch home:', error)
    }
  }
  return result
}

async function readyForkLaunchHome(
  args: AiVaultPrepareSessionResumeArgs,
  options: CodexAiVaultResumeOptions
): Promise<void> {
  if (
    !options.runtimeHome ||
    !args.codexHome ||
    args.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    parseWslUncPath(args.codexHome) !== null
  ) {
    return
  }
  // Only a home this host lists that holds this rollout: the proof a resume needs before it pins one.
  const home = resolveTrustedCodexSessionResumeHome({
    transcriptPath: args.filePath,
    trustedCodexHomes: trustedCodexResumeHomes(options.runtimeHome, getSystemCodexHomePath())
  })
  if (
    home &&
    normalizeRuntimePathForComparison(home) === normalizeRuntimePathForComparison(args.codexHome)
  ) {
    await options.preparePinnedLaunchHome(home)
  }
}
