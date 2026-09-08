import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { linkCodexRolloutIntoAccountHome } from './codex-account-session-bridge'

/** Result of placing the verified transcript in the selected account home. */
export type CodexAccountSwitchResumeOutcome =
  | { outcome: 'already-there' }
  | { outcome: 'moved'; codexHomePath: string }
  | { outcome: 'unmovable' }

/**
 * Moves an account-switch restart's resume onto the newly selected account.
 *
 * Why: the ordinary resume path pins CODEX_HOME to the home that owns the
 * rollout. That is right for a cold restore (the pane comes back as the account
 * that recorded the conversation) and wrong for an account switch, where it
 * relaunches the pane under the account the user just left, so the switch
 * appears to do nothing. Rollouts are linked/copied across managed homes, so the
 * same conversation resumes under the selected account once its file is listed
 * there.
 */
export function resolveCodexAccountSwitchResumeHome(args: {
  originCodexHomePath: string
  selectedCodexHomePath: string | null
  transcriptPath: string
  linkRollout?: typeof linkCodexRolloutIntoAccountHome
}): CodexAccountSwitchResumeOutcome {
  const selected = args.selectedCodexHomePath
  // System-default selections supply their resolved home explicitly.
  if (!selected) {
    return { outcome: 'unmovable' }
  }
  if (
    normalizeRuntimePathForComparison(selected) ===
    normalizeRuntimePathForComparison(args.originCodexHomePath)
  ) {
    return { outcome: 'already-there' }
  }
  const link = args.linkRollout ?? linkCodexRolloutIntoAccountHome
  try {
    const linkedPath = link({
      sourceCodexHomePath: args.originCodexHomePath,
      targetCodexHomePath: selected,
      rolloutFilePath: args.transcriptPath
    })
    return linkedPath ? { outcome: 'moved', codexHomePath: selected } : { outcome: 'unmovable' }
  } catch (error) {
    console.warn('[codex-account-switch] Failed to link rollout into selected home:', error)
    return { outcome: 'unmovable' }
  }
}
