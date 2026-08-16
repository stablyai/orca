import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { linkCodexRolloutIntoAccountHome } from './codex-account-session-bridge'

/**
 * Where an account-switch restart should resume from.
 *
 * `already-there` is not a move at all — the pane's own account is the selected
 * one, so the ordinary resume is correct and nothing may be given up.
 * `moved` means the conversation is listed under the selected account and can
 * be resumed there. `unmovable` means it cannot be, and the caller has to
 * choose between the account the user asked for and the conversation; it picks
 * the account, because that is what the user pressed the button for.
 */
export type CodexAccountSwitchResumeOutcome =
  | { outcome: 'already-there' }
  | { outcome: 'moved'; codexHomePath: string }
  | { outcome: 'unmovable' }

/**
 * Moves an account-switch restart's resume onto the newly selected account.
 *
 * Why: the ordinary resume path pins CODEX_HOME to the home that owns the
 * rollout. That is right for a cold restore — the pane comes back as the account
 * that recorded the conversation — and wrong for an account switch, where it
 * relaunches the pane under the account the user just left, so the switch
 * appears to do nothing. Rollouts are hardlinked across managed homes, so the
 * same conversation resumes under the selected account once its file is listed
 * there.
 *
 * Why three answers rather than a home or null: "the conversation cannot come"
 * and "there is nothing to move" look identical from a returned path, and
 * collapsing them throws away a conversation that was never in danger.
 */
export function resolveCodexAccountSwitchResumeHome(args: {
  originCodexHomePath: string
  selectedCodexHomePath: string | null
  transcriptPath: string
  linkRollout?: typeof linkCodexRolloutIntoAccountHome
}): CodexAccountSwitchResumeOutcome {
  const selected = args.selectedCodexHomePath
  // Why: the system default runs Codex against the user's own ~/.codex, which
  // Orca never writes into, so the rollout can never be listed there.
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
    // Why not fall back to the origin: resuming there relaunches the pane on the
    // account the user just left, which is the bug this whole path exists to
    // fix. Losing the conversation is the smaller failure, and the pane says so.
    console.warn('[codex-account-switch] Failed to link rollout into selected home:', error)
    return { outcome: 'unmovable' }
  }
}
