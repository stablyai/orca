import {
  CODEX_HOOK_LAUNCH_WAIT_MS,
  readEveryKnownCodexHookHashes,
  readKnownCodexHookAnswer,
  resolveCodexHookAnswerForLaunch
} from './codex-hook-hash-lookup'
import { getInPlaceCodexHookHome } from './codex-hook-orca-approvals'
import {
  reconcileCodexHookEntriesInHome,
  removeRealHomeCodexHookForOptOut
} from './codex-real-home-hook-install'

/**
 * Keeps Orca's status hook in a managed account's CODEX_HOME true to the setting, editing it in
 * place as ~/.codex is edited: the account's own hooks and their approvals stay as they are.
 * Never throws; only a Codex launch waits for Codex's answer.
 */
export async function reconcileCodexAccountHomeHook(
  homePath: string,
  isEnabled: () => boolean,
  launchesCodex: boolean
): Promise<void> {
  const home = getInPlaceCodexHookHome(homePath)
  if (!isEnabled()) {
    await removeRealHomeCodexHookForOptOut(readEveryKnownCodexHookHashes(), home)
    return
  }
  const answer =
    (await resolveCodexHookAnswerForLaunch(launchesCodex ? CODEX_HOOK_LAUNCH_WAIT_MS : 0)) ??
    readKnownCodexHookAnswer()
  if (answer?.kind === 'refused' || (answer?.kind === 'pending' && answer.codexMissing)) {
    // Why nothing: this Codex cannot approve Orca's entry, or none was found to run it.
    return
  }
  await reconcileCodexHookEntriesInHome(home, {
    hashes: answer?.kind === 'hashes' ? answer.hashes : null,
    isEnabled,
    convertOlderForms: false
  })
}
