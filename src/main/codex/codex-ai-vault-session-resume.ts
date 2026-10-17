import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import { getSystemCodexHomePath } from './codex-home-paths'
import {
  prepareCodexAccountRestartResume,
  prepareLegacySharedCodexSessionResume
} from './codex-legacy-session-resume'
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
  /** The home a kept conversation must resume in; undefined when nobody kept it. Throws to refuse. */
  resolveKeptCodexHome?: (sessionId: string) => string | undefined
}

export type NativeCodexResumePreparation = (
  args: AiVaultPrepareSessionResumeArgs,
  nativeSystemHomePath?: string
) => Promise<AiVaultPrepareSessionResumeResult>

/** Native adoption supplies its execution target; History keeps its configured storage target. */
export function codexAiVaultSessionResumePreparation(
  getOptions: () => CodexAiVaultResumeOptions
): NativeCodexResumePreparation {
  return (args, nativeSystemHomePath) => {
    const options = getOptions()
    return prepareCodexAiVaultSessionResume(args, {
      ...options,
      systemCodexHomePath: nativeSystemHomePath ?? options.systemCodexHomePath
    })
  }
}

/** Keeps window and serve AI Vault resumes behind the same refusing account-home gate. */
export async function prepareCodexAiVaultSessionResume(
  args: AiVaultPrepareSessionResumeArgs,
  options: CodexAiVaultResumeOptions
): Promise<AiVaultPrepareSessionResumeResult> {
  // Why: a kept conversation retargets to its own account, never to the selection.
  const keptHome =
    !args.fork && args.sessionId && args.executionHostId === LOCAL_EXECUTION_HOST_ID
      ? options.resolveKeptCodexHome?.(args.sessionId)
      : undefined
  const keptOnSystemDefault = keptHome !== undefined && sameHome(keptHome, getSystemCodexHomePath())
  const result = await prepareLegacySharedCodexSessionResume(args, {
    isHostSystemDefaultRealHomeSelected: () =>
      keptHome !== undefined
        ? keptOnSystemDefault
        : options.runtimeHome?.isHostSystemDefaultRealHomeSelected() === true,
    getSelectedHostAccountCodexHomePath: () =>
      keptHome !== undefined
        ? keptHome
        : (options.runtimeHome?.resolveSelectedHostAccountCodexHomePathForResume() ?? null),
    systemCodexHomePath: options.systemCodexHomePath
  })
  if (keptHome !== undefined) {
    return retargetToKeptHome(args, result, { keptHome, keptOnSystemDefault }, options)
  }
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

/** Moves a kept conversation into its account's home when the vault listed it elsewhere. */
async function retargetToKeptHome(
  args: AiVaultPrepareSessionResumeArgs,
  result: AiVaultPrepareSessionResumeResult,
  kept: { keptHome: string; keptOnSystemDefault: boolean },
  options: CodexAiVaultResumeOptions
): Promise<AiVaultPrepareSessionResumeResult> {
  const systemHome = getSystemCodexHomePath()
  const resumeHome = result.useRealCodexHome
    ? systemHome
    : (result.substituteCodexHome ?? args.codexHome)
  if (resumeHome && sameHome(resumeHome, kept.keptHome)) {
    return result
  }
  // Why: only a home this host lists may be a copy source, as for any resume it pins.
  const sourceHome = options.runtimeHome
    ? resolveTrustedCodexSessionResumeHome({
        transcriptPath: args.filePath,
        trustedCodexHomes: trustedCodexResumeHomes(options.runtimeHome, systemHome)
      })
    : null
  if (!sourceHome) {
    throw new Error(
      'Orca could not move this conversation to the Codex account it is kept on. Retry resume.'
    )
  }
  await prepareCodexAccountRestartResume({
    sourceHome,
    transcriptPath: args.filePath,
    targetHome: kept.keptHome,
    systemCodexHomePath: systemHome
  })
  await options.preparePinnedLaunchHome(kept.keptHome)
  return kept.keptOnSystemDefault
    ? { useRealCodexHome: true }
    : { useRealCodexHome: false, substituteCodexHome: kept.keptHome }
}

function sameHome(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}
