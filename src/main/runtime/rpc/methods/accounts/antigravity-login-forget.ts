import { join } from 'node:path'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { antigravityAgyOrcaAccountHome } from '../../../../antigravity/antigravity-agy-orca-home'
import { ANTIGRAVITY_CHAT_HOME_FOLDER } from '../../../../antigravity/antigravity-chat-home'
import { agentModelCatalogFingerprint } from '../../../../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { agentModelCatalogStore } from '../../../../native-chat/agent-model-catalog/agent-model-catalog-store'
import { noteAgyLoginChanged } from '../../../../antigravity/antigravity-chat-route'
import { antigravityHostCatalogFingerprints } from '../../../../antigravity/antigravity-host-acp'
import { getProfileUserDataPath } from '../../../../orca-profiles/profile-storage-paths'
import { restartIdleAgyChats, sharedAgyLaunchHome } from './antigravity-chat-backend'

function antigravityOrcaHomeCatalogFingerprints(): string[] {
  const data = getProfileUserDataPath()
  return [
    antigravityAgyOrcaAccountHome(data),
    { variable: 'GEMINI_HOME', path: join(data, ANTIGRAVITY_CHAT_HOME_FOLDER) }
  ].map((accountHome) =>
    agentModelCatalogFingerprint({ agent: 'antigravity', accountHome, wslDistro: null })
  )
}

/** What agy's own login served: the model lists taken with it, the chats running on it, and the
 *  checks that vouched for it. The catalog of the HOME chats launch with goes once that is known. */
export function forgetAgyLogin(runtime: OrcaRuntimeService): void {
  noteAgyLoginChanged()
  // Status-line readings carry no account identity, because Orca's account selection lives only in
  // the encrypted vault with the credentials; so a login change drops the held reading and the
  // next post from the new login fills it.
  runtime.getUsageRateLimits()?.clearAntigravityUsage()
  const launchHome = sharedAgyLaunchHome(runtime)
  // Orca's homes list with agy's Google login too (Enterprise, the retired server's chats).
  const own = [...antigravityHostCatalogFingerprints(), ...antigravityOrcaHomeCatalogFingerprints()]
  agentModelCatalogStore.forgetSeenRows(own)
  // A listing started after the change, such as a Refresh, is already the new login's.
  const before = agentModelCatalogStore.runningListings()
  void launchHome.then((home) => {
    const launch = home ? antigravityHostCatalogFingerprints(home) : []
    agentModelCatalogStore.forgetSeenRows(
      launch.filter((key) => !own.includes(key)),
      before
    )
  })
  restartIdleAgyChats({ runtime: 'host' })
}
